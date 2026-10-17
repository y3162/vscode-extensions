import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import { defaultControls } from '../src/capabilities.js';
import { HistoryStore } from '../src/history-store.js';
import { sessionTitle } from '../src/session-index.js';
import type { AgentSession, AgentUpdate, Selection } from '../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function settle(controller: ChatController): Promise<void> {
  const deadline = Date.now() + 1000;
  while (controller.snapshot().busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.snapshot().busy, false);
}

test('three queued prompts stay in order and a removed middle prompt never runs', async () => {
  const entered = deferred();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const runs: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(prompt, signal) {
      runs.push(prompt);
      if (prompt === 'hold') {
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          release = () => resolve();
        });
      }
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('hold');
  await entered.promise;
  controller.enqueue('second');
  controller.enqueue('third');
  controller.enqueue('fourth');
  const queued = controller.snapshot().queue.map((item) => item.text);
  assert.deepEqual(queued, ['second', 'third', 'fourth']);
  const third = controller.snapshot().queue[1]!.id;
  controller.removeQueued(third);
  assert.deepEqual(controller.snapshot().queue.map((item) => item.text), ['second', 'fourth']);
  assert.deepEqual(runs, ['hold']);
  release();
  await running;
  await settle(controller);
  assert.deepEqual(runs, ['hold', 'second', 'fourth']);
  await controller.dispose();
});

test('sending a later queued prompt runs it before the prompts that were ahead of it', async () => {
  const entered = deferred();
  const runs: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(prompt, signal) {
      runs.push(prompt);
      if (prompt !== 'hold') return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('hold');
  await entered.promise;
  controller.enqueue('a');
  controller.enqueue('b');
  controller.enqueue('c');
  const target = controller.snapshot().queue[2]!.id;
  const steered = controller.sendQueued(target);
  await running;
  await steered;
  await settle(controller);
  assert.deepEqual(runs, ['hold', 'c', 'a', 'b']);
  await controller.dispose();
});

test('Stop keeps the queue and drops an update emitted after the abort', async () => {
  const entered = deferred();
  let emit!: (update: AgentUpdate) => void;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emitUpdate) {
      emit = emitUpdate;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('hold');
  await entered.promise;
  controller.enqueue('later');
  controller.stop();
  emit({ id: 'late', role: 'assistant', text: 'should not appear' });
  await running;
  assert.equal(controller.snapshot().messages.some((message) => message.text === 'should not appear'), false);
  assert.deepEqual(controller.snapshot().queue.map((item) => item.text), ['later']);
  assert.equal(controller.snapshot().busy, false);
  await controller.dispose();
});

test('an update delivered after reset is ignored even if the session keeps calling', async () => {
  let listener: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'thread-1',
    async run(_prompt, _signal, emit) { emit({ id: 'answer', role: 'assistant', text: 'hello' }); },
    subscribeBackgroundUpdates(next) { listener = next; return () => {}; },
    async dispose() {},
  }), () => {});
  await controller.send('hello');
  const saved = listener!;
  await controller.reset();
  saved({ id: 'late', role: 'assistant', text: 'after reset' });
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.sessionId(), undefined);
});

test('a failed history flush keeps the previously saved conversation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-history-'));
  try {
    const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
    await controller.send('original');
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const store = new HistoryStore(root);
    store.schedule({ version: 1, id, updatedAt: new Date().toISOString(), controls: defaultControls('codex', 'sdk'), state: controller.snapshot() });
    await store.flush();
    await chmod(root, 0o500);
    const next = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
    await next.send('replacement');
    const failing = new HistoryStore(root);
    failing.schedule({ version: 1, id, updatedAt: new Date().toISOString(), controls: defaultControls('codex', 'sdk'), state: next.snapshot() });
    await assert.rejects(failing.flush(), /EACCES|permission/i);
    await chmod(root, 0o700);
    const reloaded = new HistoryStore(root);
    await reloaded.load();
    assert.equal(reloaded.get(id)?.state.messages.find((message) => message.role === 'user')?.text, 'original');
  } finally { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('clearing history removes the saved file and ignores a missing record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-history-clear-'));
  try {
    const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
    await controller.send('kept');
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const store = new HistoryStore(root);
    store.schedule({ version: 1, id, updatedAt: new Date().toISOString(), controls: defaultControls('codex', 'sdk'), state: controller.snapshot() });
    await store.flush();
    await store.clear(id);
    assert.equal(store.get(id), undefined);
    await assert.rejects(readFile(path.join(root, `${id}.json`), 'utf8'), { code: 'ENOENT' });
    await store.clear(id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('blank text and a path-only attachment are not sent or queued', async () => {
  let runs = 0;
  const controller = new ChatController(selection, async () => ({ async run() { runs += 1; }, async dispose() {} }), () => {});
  await controller.send('   ');
  await controller.send('', { attachments: ['notes.md'] });
  controller.enqueue('  ', { attachments: ['notes.md'] });
  assert.equal(runs, 0);
  assert.deepEqual(controller.snapshot().messages, []);
  assert.deepEqual(controller.snapshot().queue, []);
});

test('an image-only retry without images does not run a blank prompt or invent attachments', async () => {
  const images = [{ mimeType: 'image/png' as const, data: 'aW1hZ2U=', name: 'image.png' }];
  const seen: unknown[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, _emit, extras) { seen.push(extras?.images); },
    async dispose() {},
  }), () => {});
  await controller.send('', { images, attachments: ['image.png'] });
  const id = controller.snapshot().messages[0]!.id;
  await controller.send('', { retryOf: id });
  assert.deepEqual(seen, [images]);
  assert.equal(controller.snapshot().messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(controller.retryInput(id)?.extras?.images?.length, 1);
});

test('resume does not invent a zero usage baseline for the first restored turn', async () => {
  const controller = new ChatController(selection, async () => ({
    sessionId: 'thread',
    async run(_prompt, _signal, emit) {
      emit({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44, scope: 'session', source: 'codex-sdk' } } });
    },
    async dispose() {},
  }), () => {});
  controller.prepareResume('thread');
  await controller.send('again');
  assert.equal(controller.snapshot().usage?.totalTokens, 44);
  assert.equal(controller.snapshot().turns[0]?.usage, undefined);
});

test('steering a queued prompt removes it and a rejected steer leaves it queued', async () => {
  const entered = deferred();
  let accept = true;
  const steered: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async steer(text) { steered.push(text); return accept; },
    async dispose() {},
  } satisfies AgentSession), () => {});
  const running = controller.send('hold');
  await entered.promise;
  controller.enqueue('follow');
  const id = controller.snapshot().queue[0]!.id;
  accept = false;
  await assert.rejects(controller.steerQueued(id), /追加入力/);
  assert.equal(controller.snapshot().queue.length, 1);
  accept = true;
  await controller.steerQueued(id);
  assert.deepEqual(steered, ['follow', 'follow']);
  assert.deepEqual(controller.snapshot().queue, []);
  controller.stop();
  await running;
});

test('a backend without steer cannot consume the queue', async () => {
  const entered = deferred();
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('hold');
  await entered.promise;
  controller.enqueue('follow');
  const id = controller.snapshot().queue[0]!.id;
  await assert.rejects(controller.steerQueued(id), /追加入力/);
  assert.equal(controller.snapshot().queue.length, 1);
  controller.stop();
  await running;
});

test('session titles use the first line and stop at 80 characters', () => {
  assert.equal(sessionTitle(''), 'New chat');
  assert.equal(sessionTitle('   '), 'New chat');
  assert.equal(sessionTitle('  \nsecond'), 'second');
  assert.equal(sessionTitle('first line\nsecond'), 'first line');
  assert.equal(sessionTitle('x'.repeat(90)).length, 80);
});

test('sending an unknown queued id does nothing', async () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  await controller.sendQueued('missing');
  assert.deepEqual(controller.snapshot().queue, []);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('only the last unmarked assistant message is the final answer', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'a', role: 'assistant', text: 'partial', final: true });
      emit({ id: 'b', role: 'assistant', text: 'later' });
    },
    async dispose() {},
  }), () => {});
  await controller.send('hi');
  const finals = controller.snapshot().messages.filter((message) => message.final);
  assert.deepEqual(finals.map((message) => message.text), ['partial']);
});

test('two unmarked assistant messages leave the final mark on the last one', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'a', role: 'assistant', text: 'partial' });
      emit({ id: 'b', role: 'assistant', text: 'later' });
    },
    async dispose() {},
  }), () => {});
  await controller.send('hi');
  const finals = controller.snapshot().messages.filter((message) => message.final);
  assert.deepEqual(finals.map((message) => message.text), ['later']);
});
