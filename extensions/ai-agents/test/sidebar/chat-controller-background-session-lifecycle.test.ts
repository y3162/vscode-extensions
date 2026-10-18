import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatMessage, Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

test('hibernating a session unsubscribes background events and resume uses the retained session id', async () => {
  const listeners: Array<(update: AgentUpdate) => void> = [];
  const resumeIds: Array<string | undefined> = [];
  let unsubscribed = 0;
  let disposed = 0;
  let controller!: ChatController;
  controller = new ChatController(selection, async (_selection, context) => {
    resumeIds.push(context?.resumeId);
    return {
      async run(_prompt, _signal, emit) { emit({ id: 'answer', role: 'assistant', text: 'done' }); },
      subscribeBackgroundUpdates(listener) {
        listeners.push(listener);
        return () => { unsubscribed += 1; };
      },
      async dispose() { disposed += 1; },
    };
  }, () => {});
  controller.prepareResume('retained-thread');
  await controller.send('complete a turn');
  const beforeHibernate = controller.snapshot().messages.map((message) => message.text);
  await controller.hibernate();
  assert.equal(controller.hasSession(), false);
  assert.equal(controller.sessionId(), 'retained-thread');
  assert.equal(unsubscribed, 1);
  assert.equal(disposed, 1);

  listeners[0]?.({ id: 'late-background', role: 'assistant', text: 'must not enter transcript' });
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), beforeHibernate);
  await controller.openSession();
  assert.deepEqual(resumeIds, ['retained-thread', 'retained-thread']);
  assert.equal(controller.hasSession(), true);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), beforeHibernate);
  await controller.dispose();
});

test('restored sessions ignore transcript events that cannot be tied to a saved backend turn', async () => {
  const original = new ChatController(selection, async () => ({
    sessionId: 'saved-thread',
    async run(_prompt, _signal, emit) {
      emit({ id: 'answer', backendTurnId: 'backend-turn-1', backendId: 'assistant-answer', role: 'assistant', text: 'saved answer' });
    },
    async dispose() {},
  }), () => {});
  await original.send('saved prompt');
  const saved = original.snapshot();
  const unrelated: ChatMessage = { id: 'volatile-event', role: 'assistant', text: 'unlinked live event' };
  const restored = new ChatController(selection, async () => ({
    sessionId: 'saved-thread',
    async loadTranscript(emit) { emit(unrelated); },
    async run() {},
    async dispose() {},
  }), () => {});

  try {
    restored.restoreSnapshot(saved, 'saved-thread');
    await restored.openSession();
    const state = restored.snapshot();
    assert.equal(state.messages.some((message) => message.text === 'unlinked live event'), false);
    assert.equal(state.messages.some((message) => message.text === 'saved prompt'), true);
    assert.equal(state.messages.some((message) => message.text === 'saved answer'), true);
    assert.equal(state.status, 'idle');
    assert.equal(state.busy, false);
  } finally {
    await original.dispose();
    await restored.dispose();
  }
});

test('background updates without a backend session id keep a stable background origin and request usage', async () => {
  let emitBackground!: (update: AgentUpdate) => void;
  const controller = new ChatController(selection, async () => ({
    async run() {},
    subscribeBackgroundUpdates(emit) { emitBackground = emit; return () => {}; },
    async dispose() {},
  }), () => {});
  try {
    await controller.openSession();
    emitBackground({ id: 'orphan-answer', role: 'assistant', text: 'outside a turn' });
    const answer = controller.snapshot().messages.find((message) => message.text === 'outside a turn');
    assert.equal(answer?.id, 'background:orphan-answer');
    assert.equal(answer?.turnId, 'background');

    emitBackground({ id: 'orphan-usage', role: 'status', text: '', meta: {
      type: 'usage', usage: { scope: 'request', source: 'synthetic', inputTokens: 3, outputTokens: 2 },
    } });
    assert.equal(controller.snapshot().usage?.inputTokens, 3);
    assert.equal(controller.snapshot().turns.length, 0, 'orphan usage is session-visible without inventing a turn');

    emitBackground({ id: 'orphan-files', role: 'tool', text: 'file event', meta: {
      type: 'files', files: [{ path: 'report.ts', kind: 'add' }],
    } });
    assert.equal(controller.snapshot().changes.some((change) => change.path.endsWith('/report.ts')), true);
  } finally {
    await controller.dispose();
  }
});
