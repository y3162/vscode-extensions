import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, Selection } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('webview routes handle omitted optional fields with safe defaults', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const model: AgentModel = {
    id: 'default-route-model', label: 'Default route model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    window.activeTextEditor = {
      document: {
        uri: Uri.file(path.join(harness.workspacePath, 'active.ts')),
        getText: () => 'const active = true;', lineCount: 1, lineAt: () => ({ text: 'const active = true;' }),
      },
      selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };

    await harness.sidebar.handleMessage({ type: 'attach' });
    const inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'File');
    assert.equal(inserted?.text, '@active.ts ');

    await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog' });
    const catalog = view.messages.filter((message) => message.type === 'modelCatalog').at(-1);
    assert.equal(catalog?.requestId, 0);
    assert.equal(catalog?.status, 'ready');
    assert.deepEqual((catalog?.models as Array<{ id: string }>).map((item) => item.id), [model.id]);

    const beforeSelection: Selection = harness.sidebar.controller.snapshot().selection;
    await assert.rejects(harness.sidebar.handleMessage({ type: 'setModel' }), /モデル一覧に、そのモデルはありません/);
    await harness.sidebar.handleMessage({ type: 'setModelParam', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, beforeSelection);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'restoreSession' });
    await harness.sidebar.handleMessage({ type: 'revertFile' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, beforeSelection);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(commandsFor(harness.output), 0, 'no omitted-field route started a backend session');
  } finally {
    await close(harness);
  }
});

function commandsFor(output: ReturnType<typeof window.createOutputChannel>): number {
  return output.lines.filter((line) => line.includes(' start')).length;
}

test('an undefined workspaceFolders value clears a stale selection instead of throwing', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    workspace.workspaceFolders = undefined as never;
    await harness.sidebar.handleMessage({ type: 'newChat' });

    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, '');
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: '', prompt: 'do not run without a workspace' }),
      /作業対象のフォルダをVS Codeで開いてください/,
    );
    assert.equal(harness.sidebar.controller.hasSession(), false);
  } finally {
    await close(harness);
  }
});

test('an empty Cursor executable setting falls back to the default agent command', async () => {
  resetVscode();
  let optionsSeen: SessionOptions | undefined;
  const harness = withFactory(async (options) => {
    optionsSeen = options;
    return {
      sessionId: 'cursor-command-default',
      async run(_prompt, _signal, emit) { emit({ id: 'cursor-default-answer', role: 'assistant', text: 'done', final: true }); },
      async dispose() {},
    };
  });
  workspace.configuration['ai-agents']!['cursor.agentPath'] = '';
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'check configured command' });

    assert.equal(optionsSeen?.agentPath, 'agent');
    assert.equal(optionsSeen?.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'done'), true);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
  } finally {
    await close(harness);
  }
});
