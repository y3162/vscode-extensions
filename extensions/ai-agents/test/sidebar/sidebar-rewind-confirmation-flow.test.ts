import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Sidebar rewind cancellation preserves the conversation and confirmed rewind forks and resends the edited prompt', async () => {
  resetVscode();
  let currentId = 'thread-original';
  const runs: string[] = [];
  const session: AgentSession = {
    get sessionId() { return currentId; },
    async run(prompt, _signal, emit) {
      runs.push(prompt);
      emit({ id: `workspace-changes:${runs.length}`, role: 'tool', text: 'No workspace changes', backendTurnId: `backend-${runs.length}`, meta: { type: 'files', files: [] } });
      emit({ id: `answer-${runs.length}`, role: 'assistant', text: `answer: ${prompt}`, final: true, backendTurnId: `backend-${runs.length}` });
    },
    async forkBeforeTurn(turnId) { return `branch-${turnId}`; },
    activateFork(id) { currentId = id; },
    async listBackgroundTerminals() { return []; },
    async dispose() {},
  };
  const harness = withSession(async () => session);
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'original prompt' });
    const before = harness.sidebar.controller.snapshot();
    const target = before.turns[0]?.id;
    assert.ok(target);
    assert.equal(before.turns[0]?.backendTurnId, 'backend-1');

    window.warningQueue.push({ value: undefined });
    await harness.sidebar.handleMessage({ type: 'rewind', turnId: target, editedText: '  edited prompt  ' });
    assert.deepEqual(harness.sidebar.controller.snapshot().messages.map((message) => message.text), before.messages.map((message) => message.text));
    assert.equal(harness.sidebar.controller.sessionId(), 'thread-original');
    assert.deepEqual(runs, ['original prompt']);

    window.warningQueue.push({ value: 'Rewind and resend' });
    await harness.sidebar.handleMessage({ type: 'rewind', turnId: target, editedText: '  edited prompt  ' });
    const after = harness.sidebar.controller.snapshot();
    assert.equal(harness.sidebar.controller.sessionId(), `branch-backend-1`);
    assert.deepEqual(runs, ['original prompt', 'edited prompt']);
    assert.deepEqual(after.messages.filter((message) => message.role === 'user').map((message) => message.text), ['edited prompt']);
    assert.equal(after.busy, false);
    assert.equal(after.status, 'idle');
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
