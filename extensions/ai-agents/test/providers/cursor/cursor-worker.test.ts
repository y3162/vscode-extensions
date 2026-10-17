import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { attachCursorWorker } from '../../../src/providers/cursor-worker.js';
import type { AgentSession, AgentUpdate, ChatMessage, Selection, SessionSummary, TerminalRecord } from '../../../src/types.js';

interface FakeWorker extends EventEmitter {
  connected: boolean;
  messages: unknown[];
  exits: number;
  send(message: unknown): void;
  exit(): void;
}

function worker(): FakeWorker {
  return Object.assign(new EventEmitter(), {
    connected: true,
    messages: [] as unknown[],
    exits: 0,
    send(message: unknown) { this.messages.push(message); },
    exit() { this.exits += 1; },
  }) as FakeWorker;
}

function response(messages: unknown[], id: number): Record<string, unknown> | undefined {
  return messages.filter((value) => (value as { id?: number }).id === id).at(-1) as Record<string, unknown> | undefined;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(check(), true);
}

test('Cursor worker forwards initialization, updates, terminal and transcript requests, and disposal', async () => {
  const process = worker();
  const background: Array<(update: AgentUpdate) => void> = [];
  const identities: SessionSummary[] = [];
  const calls: string[] = [];
  let initialized: Record<string, unknown> | undefined;
  let disposed = 0;
  let runtimeDisposals = 0;
  const session: AgentSession = {
    sessionId: 'agent-1',
    subscribeBackgroundUpdates(listener) { background.push(listener); return () => {}; },
    async run(prompt, signal, emit, extras, turn) {
      calls.push(`run:${prompt}:${Boolean(extras)}:${turn?.mode}`);
      assert.equal(signal.aborted, false);
      emit({ id: 'from-run', role: 'assistant', text: 'answer' });
    },
    async listBackgroundTerminals() { calls.push('terminals'); return [{ processId: 'p1', status: 'running' }]; },
    async interruptBackgroundTerminal(id) { calls.push(`interrupt:${id}`); },
    async setModel(selection) { calls.push(`model:${selection.model}`); },
    async setMode(mode) { calls.push(`mode:${mode}`); },
    async loadTranscript(emit) { emit({ id: 'saved', role: 'assistant', text: 'history' }); },
    async dispose() { disposed += 1; },
  };
  attachCursorWorker(process, async (options, _loaders, inProcess) => {
    initialized = options as unknown as Record<string, unknown>;
    assert.equal(inProcess, true);
    return session;
  }, { dispose() { runtimeDisposals += 1; } });
  const ask = async (id: number, method: string, args: unknown = {}) => {
    process.emit('message', { id, method, args });
    await until(() => response(process.messages, id) !== undefined);
    return response(process.messages, id)!;
  };

  assert.deepEqual(await ask(1, 'initialize', { provider: 'cursor', cwd: '/workspace', apiKey: 'fixture-key' }), { id: 1, value: undefined });
  assert.equal(initialized?.apiKey, 'fixture-key');
  assert.equal(typeof initialized?.onIdentity, 'function');
  (initialized?.onIdentity as (summary: SessionSummary) => void)({ id: 'agent-1', title: 'Cursor', updatedAt: 'now', provider: 'cursor', cwd: '/workspace' });
  assert.equal((process.messages.at(-1) as { identity?: SessionSummary }).identity?.id, 'agent-1');
  const update: AgentUpdate = { id: 'background', role: 'status', text: 'later' };
  background[0]!(update);
  assert.equal((process.messages.at(-1) as { backgroundUpdate?: AgentUpdate }).backgroundUpdate, update);

  assert.deepEqual(await ask(2, 'terminals'), { id: 2, value: [{ processId: 'p1', status: 'running' }] satisfies TerminalRecord[] });
  assert.deepEqual(await ask(3, 'interruptTerminal', 'p1'), { id: 3, value: undefined });
  assert.deepEqual(await ask(4, 'setModel', { provider: 'cursor', cwd: '/workspace', model: 'new' } satisfies Selection), { id: 4, value: undefined });
  assert.deepEqual(await ask(5, 'setMode', 'plan'), { id: 5, value: undefined });
  assert.deepEqual(await ask(6, 'transcript'), { id: 6, value: [{ id: 'saved', role: 'assistant', text: 'history' } satisfies ChatMessage] });
  assert.deepEqual(await ask(8, 'cancel'), { id: 8, value: undefined }, 'cancel without a run is a harmless no-op');
  process.emit('message', { id: 7, method: 'run', args: { prompt: 'hello', extras: { images: [] }, turn: { mode: 'agent' } } });
  await until(() => response(process.messages, 7) !== undefined);
  assert.equal(response(process.messages, 7)?.id, 7);
  assert.deepEqual(calls, ['terminals', 'interrupt:p1', 'model:new', 'mode:plan', 'run:hello:true:agent']);
  assert.equal((process.messages.find((item) => (item as { update?: AgentUpdate }).update?.id === 'from-run') as { update: AgentUpdate }).update.text, 'answer');
  await ask(8, 'dispose');
  assert.equal(runtimeDisposals, 1);
  assert.equal(disposed, 1);
});

test('Cursor worker reports unsupported operations and preserves SDK error metadata', async () => {
  const process = worker();
  const session: AgentSession = { sessionId: 'minimal', async run() {}, async dispose() {} };
  attachCursorWorker(process, async () => session, { dispose() {} });
  process.emit('message', { id: 1, method: 'initialize', args: {} });
  await until(() => response(process.messages, 1) !== undefined);
  process.emit('message', { id: 2, method: 'setModel', args: {} });
  await until(() => response(process.messages, 2) !== undefined);
  assert.match(String((response(process.messages, 2)?.error as { message: string }).message), /does not support model changes/);
  assert.deepEqual(await (async () => {
    process.emit('message', { id: 3, method: 'terminals' });
    await until(() => response(process.messages, 3) !== undefined);
    return response(process.messages, 3);
  })(), { id: 3, value: undefined });
  process.emit('message', { id: 4, method: 'interruptTerminal', args: 'gone' });
  await until(() => response(process.messages, 4) !== undefined);
  assert.deepEqual(response(process.messages, 4), { id: 4, value: undefined });
  process.emit('message', { id: 5, method: 'transcript' });
  await until(() => response(process.messages, 5) !== undefined);
  assert.deepEqual(response(process.messages, 5), { id: 5, value: [] });
  process.emit('message', { id: 6, method: 'unknown' });
  await until(() => response(process.messages, 6) !== undefined);
  assert.equal((response(process.messages, 6)?.error as { message: string }).message, 'Unknown Cursor worker operation');
  const rejected = worker();
  attachCursorWorker(rejected, async () => { throw Object.assign(new Error('auth failed'), { isRetryable: true, operation: 'create' }); }, { dispose() {} });
  rejected.emit('message', { id: 1, method: 'initialize', args: {} });
  await until(() => response(rejected.messages, 1) !== undefined);
  assert.deepEqual(response(rejected.messages, 1)?.error, { name: 'Error', message: 'auth failed', isRetryable: true, operation: 'create' });
});

test('worker disconnect aborts the active run, disposes its session, and exits after cleanup', async () => {
  const process = worker();
  let started!: () => void;
  let disposed = 0;
  let aborted = false;
  let runtimeDisposals = 0;
  const session: AgentSession = {
    sessionId: 'active',
    async run(_prompt, signal) {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    },
    async dispose() { disposed += 1; },
  };
  const running = new Promise<void>((resolve) => { started = resolve; });
  attachCursorWorker(process, async () => session, { dispose() { runtimeDisposals += 1; } });
  process.emit('message', { id: 1, method: 'initialize', args: {} });
  await until(() => response(process.messages, 1) !== undefined);
  process.emit('message', { id: 2, method: 'run', args: { prompt: 'hold' } });
  await running;
  process.emit('disconnect');
  await until(() => process.exits === 1);
  assert.equal(aborted, true);
  assert.equal(disposed, 1);
  assert.equal(runtimeDisposals, 1);

  const closed = worker();
  attachCursorWorker(closed, async () => ({ sessionId: 'closed', async run() {}, async dispose() {} }), { dispose() {} });
  closed.connected = false;
  closed.emit('message', null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed.messages, []);
});

test('worker cancel aborts the active run and acknowledges cancellation', async () => {
  const process = worker();
  let entered!: () => void;
  let aborted = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const session: AgentSession = {
    async run(_prompt, signal) {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    },
    async dispose() {},
  };
  attachCursorWorker(process, async () => session, { dispose() {} });
  process.emit('message', { id: 1, method: 'initialize', args: {} });
  await until(() => response(process.messages, 1) !== undefined);
  process.emit('message', { id: 2, method: 'run', args: { prompt: 'wait' } });
  await started;
  process.emit('message', { id: 3, method: 'cancel' });
  await until(() => response(process.messages, 2) !== undefined && response(process.messages, 3) !== undefined);
  assert.equal(aborted, true);
  assert.deepEqual(response(process.messages, 3), { id: 3, value: undefined });
});
