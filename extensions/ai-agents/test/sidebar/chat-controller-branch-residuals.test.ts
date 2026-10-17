import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import type { AgentSession, AgentUpdate, ChatMessage, Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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

test('reset denies the pending permission queue and resolves plan and question waits before clearing state', async () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const permissionRequest = { kind: 'shell' as const, title: 'Run command', detail: 'echo safe' };
  const permissionOne = controller.interactions.requestPermission({ ...permissionRequest, id: 'permission-1' });
  const permissionTwo = controller.interactions.requestPermission({ ...permissionRequest, id: 'permission-2' });
  const plan = controller.interactions.requestPlan({ id: 'plan-1', plan: 'Plan body', todos: [{ content: 'step', status: 'pending' }] });
  const answers = controller.interactions.requestAnswers({ id: 'question-1', questions: [] });
  assert.equal(controller.snapshot().pendingPermission?.id, 'permission-1');
  assert.equal(controller.snapshot().pendingPlan?.id, 'plan-1');
  assert.equal(controller.snapshot().pendingQuestion?.id, 'question-1');

  await controller.reset();
  assert.deepEqual(await Promise.all([permissionOne, permissionTwo]), ['deny', 'deny']);
  assert.equal(await plan, 'rejected');
  assert.deepEqual(await answers, {});
  const state = controller.snapshot();
  assert.equal(state.pendingPermission, null);
  assert.equal(state.pendingPlan, null);
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.busy, false);
  assert.equal(state.status, 'idle');
  assert.equal(state.queue.length, 0);
  await controller.dispose();
});

test('resetting an active code review releases the busy state without leaving a cancellation status', async () => {
  const entered = deferred<void>();
  let controller!: ChatController;
  controller = new ChatController(selection, async () => ({
    async run() {},
    async review(_target, _emit, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    },
    async dispose() {},
  }), () => {});

  await controller.openSession();
  const review = controller.review('uncommitted');
  await entered.promise;
  const resetting = controller.reset();
  await Promise.all([review, resetting]);
  const state = controller.snapshot();
  assert.equal(state.busy, false);
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.messages, []);
  assert.equal(controller.hasSession(), false);
});

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

test('a running send refuses a provider switch before disposing its active session', async () => {
  const entered = deferred();
  let disposed = 0;
  let factoryCalls = 0;
  const controller = new ChatController(selection, async () => {
    factoryCalls += 1;
    return {
      async run(_prompt, signal) {
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
      async dispose() { disposed += 1; },
    };
  }, () => {});
  try {
    const active = controller.send('hold the current conversation');
    await entered.promise;
    await assert.rejects(controller.select({ ...selection, provider: 'cursor' }), /実行が終わってから/);
    assert.equal(factoryCalls, 1);
    assert.equal(disposed, 0);
    controller.stop();
    await active;
    assert.equal(disposed, 0, 'finishing the rejected switch leaves the current session usable');
    await controller.reset();
    assert.equal(disposed, 1);
    assert.equal(controller.snapshot().selection.provider, 'codex');
  } finally {
    await controller.dispose();
  }
});
