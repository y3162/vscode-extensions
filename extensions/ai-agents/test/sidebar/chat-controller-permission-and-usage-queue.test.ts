import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, ImageAttachment, Selection } from '../../src/types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('request usage is ignored once a session sample exists and is not added again', async () => {
  let phase: 'session-first' | 'request-first' = 'session-first';
  const controller = new ChatController(selection(), async () => ({
    async run(_prompt, _signal, emit) {
      const usage = (scope: 'session' | 'request', input: number, id: string): AgentUpdate => ({ id, role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: input, outputTokens: 1, totalTokens: input + 1, scope, source: 'codex' } } });
      if (phase === 'session-first') {
        emit(usage('session', 10, 'session'));
        emit(usage('request', 1_000, 'request'));
      } else {
        emit(usage('request', 10, 'request'));
        emit(usage('session', 30, 'session'));
      }
    },
    async dispose() {},
  }), () => {});
  await controller.send('first');
  assert.equal(controller.snapshot().usage?.inputTokens, 10);
  assert.equal(controller.snapshot().turns[0]?.usage?.inputTokens, 10);
  const firstTurnId = controller.snapshot().turns[0]!.id;
  assert.equal(controller.snapshot().usageSamples?.[`run:${firstTurnId}:request`], undefined);
  phase = 'request-first';
  await controller.send('second');
  assert.equal(controller.snapshot().usage?.inputTokens, 30);
  assert.notEqual(controller.snapshot().usage?.inputTokens, 40);
  assert.equal(controller.snapshot().turns.length, 2);
});

test('a second queued permission is settled with the first and is not approved early', async () => {
  const started = deferred();
  const decisions: string[] = [];
  let opens = 0;
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      sessionId: 'thread-1',
      async run() {
        const first = controller.interactions.requestPermission({ id: 'one', title: 'One', detail: 'd', kind: 'shell' });
        const second = controller.interactions.requestPermission({ id: 'two', title: 'Two', detail: 'e', kind: 'write' });
        started.resolve();
        decisions.push(await first, await second);
      },
      async dispose() {},
    };
  }, () => {});
  const sending = controller.send('go');
  await started.promise;
  assert.equal(controller.snapshot().pendingPermission?.id, 'one');
  controller.resolvePermission('one', 'deny', 'wrong-token');
  assert.equal(controller.snapshot().pendingPermission?.id, 'one');
  controller.stop();
  await sending;
  assert.deepEqual(decisions, ['deny', 'deny']);
  assert.equal(controller.snapshot().pendingPermission, null);
  assert.equal(controller.snapshot().queue.length, 0);
  assert.equal(controller.snapshot().turns[0]?.status, 'cancelled');
  assert.equal(opens, 1);

  const again = deferred();
  const later: string[] = [];
  let follow!: ChatController;
  follow = new ChatController(selection(), async () => ({
    async run() {
      const first = follow.interactions.requestPermission({ id: 'one', title: 'One', detail: 'd', kind: 'shell' });
      const second = follow.interactions.requestPermission({ id: 'two', title: 'Two', detail: 'e', kind: 'write' });
      again.resolve();
      later.push(await first, await second);
    },
    async dispose() {},
  }), () => {});
  const secondSend = follow.send('go');
  await again.promise;
  const firstToken = follow.interactionTokens().permission!;
  follow.resolvePermission('one', 'allow-once', firstToken);
  assert.equal(follow.snapshot().pendingPermission?.id, 'two');
  assert.deepEqual(later, []);
  follow.resolvePermission('two', 'deny', follow.interactionTokens().permission!);
  await secondSend;
  assert.deepEqual(later, ['allow-once', 'deny']);
  assert.equal(follow.snapshot().turns[0]?.status, 'completed');
  assert.equal(follow.snapshot().messages.filter((message) => message.role === 'user').length, 1);
});
