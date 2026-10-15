import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import type { AgentSession, Selection } from '../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('continues the same session and replaces item snapshots without mixing turn IDs', async () => {
  let created = 0;
  const session: AgentSession = {
    async run(prompt, _signal, emit) {
      emit({ id: 'item_0', role: 'assistant', text: 'partial' });
      emit({ id: 'item_0', role: 'assistant', text: `reply: ${prompt}` });
    }, async dispose() {},
  };
  const controller = new ChatController(selection, async () => { created++; return session; }, () => {});
  await controller.send('first');
  await controller.send('second');
  assert.equal(created, 1);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['first', 'reply: first', 'second', 'reply: second']);
  assert.equal(new Set(controller.snapshot().messages.map((message) => message.id)).size, 4);
});

test('rejects simultaneous sends, aborts the active run, and allows a follow-up', async () => {
  const entered = deferred();
  let count = 0;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emit) {
      if (++count === 1) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } else emit({ id: 'answer', role: 'assistant', text: 'recovered' });
    }, async dispose() {},
  }), () => {});
  const running = controller.send('long request');
  await entered.promise;
  await assert.rejects(controller.send('overlap'), /実行中/);
  controller.stop();
  await running;
  assert.equal(controller.snapshot().busy, false);
  assert.ok(controller.snapshot().messages.some((message) => message.text === '停止しました。'));
  await controller.send('follow-up');
  assert.equal(controller.snapshot().messages.at(-1)?.text, 'recovered');
});

test('Stop during asynchronous session initialization prevents any prompt from running', async () => {
  const initialized = deferred();
  let runs = 0;
  let disposed = 0;
  const controller = new ChatController(selection, async () => {
    await initialized.promise;
    return { async run() { runs++; }, async dispose() { disposed++; } };
  }, () => {});
  const running = controller.send('do not run');
  controller.stop();
  initialized.resolve();
  await running;
  await controller.reset();
  assert.equal(runs, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('switching providers disposes the old session and clears its transcript', async () => {
  let disposed = 0;
  const seen: string[] = [];
  const controller = new ChatController(selection, async (options) => {
    seen.push(options.provider);
    return { async run() {}, async dispose() { disposed++; } };
  }, () => {});
  await controller.send('Codex');
  await controller.select({ ...selection, provider: 'cursor' });
  assert.equal(disposed, 1);
  assert.deepEqual(controller.snapshot().messages, []);
  await controller.send('Cursor');
  assert.deepEqual(seen, ['codex', 'cursor']);
});

test('initialization errors appear in the transcript and can be retried', async () => {
  let attempts = 0;
  const controller = new ChatController(selection, async () => {
    if (++attempts === 1) throw new Error('Please sign in');
    return { async run() {}, async dispose() {} };
  }, () => {});
  await controller.send('first');
  assert.equal(controller.snapshot().messages.at(-1)?.role, 'error');
  assert.equal(controller.snapshot().messages.at(-1)?.text, 'Please sign in');
  assert.equal(controller.snapshot().busy, false);
  await controller.send('retry');
  assert.equal(attempts, 2);
});

test('reset waits for cleanup and blocks new work until disposal completes', async () => {
  const cleanup = deferred();
  const controller = new ChatController(selection, async () => ({
    async run() {}, async dispose() { await cleanup.promise; },
  }), () => {});
  await controller.send('hello');
  const resetting = controller.reset();
  await assert.rejects(controller.send('during reset'), /実行中/);
  cleanup.resolve();
  await resetting;
  assert.equal(controller.snapshot().busy, false);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('a prompt immediately following a selection change waits for old-session cleanup', async () => {
  const cleanup = deferred();
  const providers: string[] = [];
  const controller = new ChatController(selection, async (options) => {
    providers.push(options.provider);
    return { async run() {}, async dispose() { await cleanup.promise; } };
  }, () => {});
  await controller.send('first');
  const next = { ...selection, provider: 'cursor' as const };
  const changing = controller.select(next);
  const sending = (async () => { await controller.select(next); await controller.send('immediate send'); })();
  cleanup.resolve();
  await Promise.all([changing, sending]);
  assert.deepEqual(providers, ['codex', 'cursor']);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['immediate send']);
});
