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
