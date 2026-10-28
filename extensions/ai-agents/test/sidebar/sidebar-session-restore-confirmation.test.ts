import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('an assistant-only CLI conversation stays visible when changing models', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionId = 'round18-assistant-only-session';
  const sessionOptions: SessionOptions[] = [];
  let disposed = 0;
  const restoredSession: AgentSession = {
    sessionId,
    async loadTranscript(emit) {
      emit({ id: 'round18-assistant-answer', role: 'assistant', text: 'A saved assistant-only response.', final: true, backendTurnId: 'turn-1', backendId: 'answer' });
    },
    async run() {},
    async dispose() { disposed += 1; },
  };
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions) => {
    sessionOptions.push(options);
    return restoredSession;
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const replacement: AgentModel = { id: 'round18-replacement-model', label: 'Replacement model' };
  sidebar.listAvailableModels = async () => [replacement];

  try {
    sidebar.controller.replaceSessions([{
      id: sessionId, title: 'Assistant only', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', backend: 'cli', cwd: paths.workspacePath,
    }]);
    await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });
    const original = sidebar.controller;
    assert.deepEqual(original.snapshot().messages.map(({ role, text }) => ({ role, text })), [
      { role: 'assistant', text: 'A saved assistant-only response.' },
    ]);
    assert.equal(original.sessionId(), sessionId);
    assert.equal(sessionOptions[0]?.resumeId, sessionId);

    await sidebar.handleMessage({ type: 'setModel', modelId: replacement.id });
    assert.equal(window.warningMessages.length, 0);
    assert.equal(sidebar.controller, original);
    assert.equal(original.snapshot().selection.model, replacement.id);
    assert.equal(original.snapshot().messages[0]?.text, 'A saved assistant-only response.');
    assert.equal(original.sessionId(), sessionId);
    assert.equal(disposed, 0);
  } finally {
    await close(harness);
  }
});
