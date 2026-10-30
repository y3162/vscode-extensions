import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, env, languages, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor rejection keeps the model list in the redacted log but summarizes it in the webview', async () => {
  resetVscode();
  const harness = withFactory(async () => ({
    async run() { throw new Error('Cannot use this model: composer-2.5. Available models: auto, composer-2.5 token=secret'); },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.controller.select({ provider: 'cursor', cwd: harness.workspacePath, model: 'composer-2.5' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'hello' });
    const visible = JSON.stringify(view.messages);
    assert.match(visible, /composer-2\.5/);
    assert.doesNotMatch(visible, /Available models/);
    assert.match(harness.output.lines.join('\n'), /Available models: auto/);
    assert.doesNotMatch(harness.output.lines.join('\n'), /token=secret/);
  } finally { await close(harness); }
});

test('empty Codex executable setting uses the bundled launcher and records its version before sending', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: 'round12-bundled-launch',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: 'round12-bundled-final', role: 'assistant', text: 'sent through fake transport', final: true });
    },
    async dispose() {},
  }));
  workspace.configuration['ai-agents']!['codex.executablePath'] = '';
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'exercise bundled launch metadata' });

    const start = harness.output.lines.find((line) => line.includes(' start')) ?? '';
    assert.match(start, /^\[codex\/cli\] bundled \S+ /);
    assert.match(start, /codex\.js start$/);
    assert.deepEqual(runs, ['exercise bundled launch metadata']);
    assert.equal(harness.sidebar.controller.snapshot().status, 'idle');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'sent through fake transport'), true);
  } finally {
    await close(harness);
  }
});
