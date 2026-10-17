import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentUpdate } from '../../src/types.js';
import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'round11-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round11-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  })) as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('English Git context insertion labels and forwards the generated workspace summary', async () => {
  resetVscode();
  env.language = 'en-US';
  const harness = openSidebar();
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.insertContext('git');

    const inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'Git diff');
    assert.match(String(inserted?.text), /git status:/);
    assert.ok(commands.executed.some((entry) => entry.command === 'ai-agents.chat.focus'));
  } finally {
    await close(harness);
  }
});

test('empty Build model IDs fail without changing the plan, and ACP ignores unsupported model changes', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    let catalogCalls = 0;
    harness.sidebar.listAvailableModels = async () => {
      catalogCalls += 1;
      return [{ id: 'cursor-build-model', label: 'Cursor build model' }];
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: '# Ready' }],
      current: { id: 'round11-build', revision: 1, markdown: '# Ready', todos: [], source: 'assistant-text', createdAt: 1 },
      build: { selection: { ...state.selection, model: 'saved-build-model' }, label: 'Saved build model' },
    };
    harness.sidebar.controller.restoreSnapshot(state);
    const savedBuild = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: '' }),
      /モデル一覧に、そのモデルはありません/,
    );
    assert.equal(catalogCalls, 1, 'an empty ID is treated as no matching catalog choice');
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, savedBuild);

    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'acp' });
    const cursorState = harness.sidebar.controller.snapshot();
    cursorState.plan.phase = 'ready';
    cursorState.plan.current = { id: 'round11-cursor-build', revision: 2, markdown: '# Cursor', todos: [], source: 'assistant-text', createdAt: 2 };
    cursorState.plan.revisions = [{ revision: 2, createdAt: 2, source: 'assistant-text', markdown: '# Cursor' }];
    cursorState.plan.build = { selection: { ...cursorState.selection, model: 'cursor-build-model' }, label: 'Cursor build model' };
    harness.sidebar.controller.restoreSnapshot(cursorState);
    await harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'cursor-build-model' });

    assert.equal(catalogCalls, 2, 'ACP Build selection reads the model catalog');
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.selection.model, 'cursor-build-model');
  } finally {
    await close(harness);
  }
});

test('an absolute review path remains resolvable under an opened workspace when selection cwd is empty', async () => {
  resetVscode();
  const harness = openSidebar();
  const currentFile = path.join(harness.workspacePath, 'absolute-review.txt');
  writeFileSync(currentFile, 'current workspace content');
  try {
    const state = harness.sidebar.controller.snapshot();
    state.selection = { ...state.selection, cwd: '' };
    state.changes = [{ path: currentFile, kind: 'update', previousText: 'saved baseline' }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: currentFile });

    const diff = commands.executed.find((entry) => entry.command === 'vscode.diff');
    assert.ok(diff, 'an absolute path under the workspace does not require a selected cwd');
    const baseline = diff.args[0] as Uri;
    assert.equal(readFileSync(baseline.fsPath, 'utf8'), 'saved baseline');
    assert.equal(readFileSync(currentFile, 'utf8'), 'current workspace content', 'opening review never edits the user file');
    assert.equal((diff.args[1] as Uri).fsPath, currentFile);
  } finally {
    await close(harness);
  }
});

test('Cursor diagnostic failures retain separate version and status results without affecting the session state', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const cli = path.join(harness.root, 'cursor-failing-diagnostics.cjs');
  writeFileSync(cli, [
    "if (process.argv[2] === '--version') { process.stderr.write('synthetic version failure'); process.exitCode = 17; }",
    "else { process.stderr.write('synthetic status failure'); process.exitCode = 18; }",
  ].join('\n'));
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const original = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(original);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-out' }) });

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /FAIL Cursor CLI \(override\)/);
    assert.match(report, /synthetic version failure/);
    assert.match(report, /FAIL .*cursor-failing-diagnostics\.cjs status/);
    assert.match(report, /synthetic status failure/);
    assert.match(report, /FAIL Cursor SDK auth\nlogged-out/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    Object.defineProperty(auth, 'status', original);
    await close(harness);
  }
});

test('removing an additional directory in Japanese resets the live session and reports the localized reason', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = withSession();
  const additional = path.join(harness.root, 'round11-additional');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start before adding directory' });
    window.openDialogQueue.push([Uri.file(additional)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start before removing directory' });
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: additional });

    const controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls');
    assert.deepEqual(controls?.codex?.additionalDirectories, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('設定を変更したため、新しい会話になりました。')));
  } finally {
    await close(harness);
  }
});
