import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatMessage, Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

test('a non-retryable backend error is represented once with repair guidance and leaves no queued retry', async () => {
  const failure = Object.assign(new Error('policy rejected request'), { isRetryable: false, operation: 'run' });
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'same-failure', role: 'error', text: failure.message });
      throw failure;
    },
    async dispose() {},
  }), () => {});

  await controller.send('attempt a rejected operation');
  const state = controller.snapshot();
  const errors = state.messages.filter((message) => message.role === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.failure?.kind, 'Error');
  assert.equal(errors[0]?.failure?.retryable, false);
  assert.equal(errors[0]?.failure?.operation, 'run');
  assert.equal(errors[0]?.text, failure.message, 'the backend-provided error row remains the sole visible failure row');
  assert.equal(state.turns.at(-1)?.status, 'failed');
  assert.equal(state.status, 'error');
  assert.equal(state.busy, false);
  assert.equal(state.queue.length, 0);
  await controller.dispose();
});

test('a newly created non-retryable error explains that configuration must be fixed before retrying', async () => {
  const failure = Object.assign(new Error('sandbox policy rejected the operation'), { isRetryable: false, operation: 'run' });
  const controller = new ChatController(selection, async () => ({
    async run() { throw failure; },
    async dispose() {},
  }), () => {});

  await controller.send('attempt an operation outside policy');
  const state = controller.snapshot();
  const errors = state.messages.filter((message) => message.role === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.failure?.retryable, false);
  assert.equal(errors[0]?.failure?.operation, 'run');
  assert.match(errors[0]?.text ?? '', /設定の修正が必要です/);
  assert.equal(state.status, 'error');
  assert.equal(state.busy, false);
  assert.equal(state.queue.length, 0);
  await controller.dispose();
});

test('a non-Error backend rejection is converted to a stable visible Error failure', async () => {
  const controller = new ChatController(selection, async () => ({
    async run() { throw 'synthetic non-Error rejection'; },
    async dispose() {},
  }), () => {});

  await controller.send('handle an invalid backend rejection');
  const state = controller.snapshot();
  const error = state.messages.find((message) => message.role === 'error');
  assert.equal(error?.text, 'synthetic non-Error rejection');
  assert.equal(error?.failure?.kind, 'Error');
  assert.equal(error?.failure?.retryable, true);
  assert.equal(state.status, 'error');
  assert.equal(state.busy, false);
  assert.equal(state.queue.length, 0);
  await controller.dispose();
});

test('retry failures merge into the original error card when backend text adds a prefix', async () => {
  let attempt = 0;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      attempt += 1;
      emit({ id: `failure-${attempt}`, role: 'error', text: `Backend detail: request failed` });
      throw Object.assign(new Error('request failed'), { operation: `attempt-${attempt}` });
    },
    async dispose() {},
  }), () => {});

  try {
    await controller.send('retry this request');
    const userId = controller.snapshot().messages.find((message) => message.role === 'user')!.id;
    await controller.send('retry this request', { retryOf: userId });

    const state = controller.snapshot();
    const errors = state.messages.filter((message) => message.role === 'error');
    assert.equal(attempt, 2);
    assert.equal(errors.length, 1, 'the retry updates the original card instead of adding a duplicate');
    assert.equal(errors[0]?.text, 'Backend detail: request failed');
    assert.equal(errors[0]?.turnId, userId);
    assert.equal(errors[0]?.failure?.operation, 'attempt-2');
    assert.equal(state.turns.at(-1)?.status, 'failed');
    assert.equal(state.busy, false);
  } finally {
    await controller.dispose();
  }
});
