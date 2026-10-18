import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('openSession waits for an in-flight reset and then opens the cleared conversation', async () => {
  const disposeEntered = deferred();
  const releaseDispose = deferred();
  let opens = 0;
  let disposals = 0;
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      async run() {},
      async dispose() {
        disposals += 1;
        if (disposals === 1) { disposeEntered.resolve(); await releaseDispose.promise; }
      },
    };
  }, () => {});
  try {
    await controller.send('before reset');
    const resetting = controller.reset();
    await disposeEntered.promise;
    const opening = controller.openSession();
    assert.equal(opens, 1, 'the session factory waits until reset releases the prior session');
    releaseDispose.resolve();
    await Promise.all([resetting, opening]);
    assert.equal(opens, 2);
    assert.equal(controller.hasSession(), true);
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    releaseDispose.resolve();
    await controller.dispose();
  }
});

test('openSession rejects a concurrent model update', async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async setModel() { entered.resolve(); await release.promise; },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('open session');
    const changing = controller.updateSelection({ ...selection(), model: 'next' });
    await entered.promise;
    await assert.rejects(controller.openSession(), /実行中です/);
    release.resolve();
    await changing;
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('duplicate reset calls share the same in-flight reset operation', async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async dispose() { entered.resolve(); await release.promise; },
  }), () => {});
  await controller.send('session');
  const first = controller.reset();
  await entered.promise;
  const second = controller.reset();
  assert.equal(second, first);
  release.resolve();
  await Promise.all([first, second]);
  await controller.dispose();
});

test('a runtime session factory that violates its contract fails restoration without leaving a busy session', async () => {
  const invalidFactory = async () => undefined as unknown as AgentSession;
  const controller = new ChatController(selection(), invalidFactory, () => {});
  try {
    controller.prepareResume('retained-thread');
    await controller.openSession();
    assert.equal(controller.snapshot().status, 'error');
    assert.equal(controller.snapshot().messages.at(-1)?.role, 'error');
    assert.equal(controller.sessionId(), 'retained-thread');
    assert.equal(controller.hasSession(), false);
  } finally {
    await controller.dispose();
  }
});
