import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a sandbox confirmation cannot apply after another settings change supersedes it', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  let disposed = 0;
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async () => ({
    sessionId: 'settings-race-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: 'settings-race-answer', role: 'assistant', text: 'session is live', final: true });
    },
    async dispose() { disposed += 1; },
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const promptShown = deferred<void>();
  const confirmation = deferred<string | undefined>();
  const originalWarning = window.showWarningMessage;
  window.showWarningMessage = (message: string) => {
    assert.match(message, /サンドボックスを無効/);
    promptShown.resolve();
    return confirmation.promise;
  };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: paths.workspacePath, prompt: 'keep policy safe' });
    const sessionMessages = sidebar.controller.snapshot().messages;
    const disabling = sidebar.handleMessage({ type: 'configure', sandbox: 'disabled' });
    await promptShown.promise;

    await sidebar.handleMessage({ type: 'configure', mode: 'plan' });
    confirmation.resolve('保護を解除する');
    await disabling;

    const saved = paths.context.workspaceState.get<Record<string, { sandbox: string; backend: string }>>('ai-agents.controls')?.cursor;
    assert.equal(saved?.sandbox, 'enabled');
    assert.equal(saved?.backend, 'cli');
    assert.equal(disposed, 1, 'the independent network setting change safely reset the active session once');
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.text === 'keep policy safe'), false);
    assert.ok(sessionMessages.some((message) => message.text === 'keep policy safe'));
  } finally {
    confirmation.resolve(undefined);
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});
