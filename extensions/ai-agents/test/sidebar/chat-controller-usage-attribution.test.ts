import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('background usage without a live turn is attributed to the session id and only updates aggregate usage', async () => {
  let background: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'background-session',
    subscribeBackgroundUpdates(listener) { background = listener; return () => { background = undefined; }; },
    async run() {},
    async dispose() {},
  }), () => {});
  try {
    await controller.openSession();
    background?.({ id: 'usage-event', role: 'status', text: 'usage', meta: { type: 'usage', usage: {
      inputTokens: 9, outputTokens: 2, totalTokens: 11, scope: 'run', source: 'background', sampleId: 'sample-1',
    } } });
    const state = controller.snapshot();
    const usageMessage = state.messages.find((item) => item.id === 'background-session:usage-event');
    assert.equal(usageMessage?.turnId, 'background-session');
    assert.equal(state.usage?.inputTokens, 9);
    assert.equal(state.usage?.scope, 'session');
    assert.equal(state.turns.length, 0);
  } finally {
    await controller.dispose();
  }
});

test('background updates use the current turn while running and the last completed turn afterward', async () => {
  let background: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'origin-session',
    subscribeBackgroundUpdates(listener) { background = listener; return () => { background = undefined; }; },
    async run() {
      background?.({ id: 'during-run', role: 'assistant', text: 'live event' });
    },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('one turn');
    const turnId = controller.snapshot().turns[0]!.id;
    assert.equal(controller.snapshot().messages.find((item) => item.id === `${turnId}:during-run`)?.turnId, turnId);

    background?.({ id: 'after-run', role: 'assistant', text: 'late event' });
    const state = controller.snapshot();
    assert.equal(state.messages.find((item) => item.id === `${turnId}:after-run`)?.turnId, turnId);
    assert.equal(state.turns.length, 1);
  } finally {
    await controller.dispose();
  }
});
