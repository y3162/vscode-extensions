import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { createCursorWorker } from '../../../src/providers/cursor-worker-client.js';
import type { AgentUpdate, ChatMessage, SessionSummary } from '../../../src/types.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Sent { id: number; method: string; args?: unknown }
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  sent: Sent[];
  kills: Array<string | number | undefined>;
  send(message: Sent, callback: (error?: Error | null) => void): void;
  kill(signal?: string | number): boolean;
}

function installFork(behavior: {
  failSend?: boolean | ((message: Sent) => boolean);
  onSend?: (message: Sent, child: FakeChild) => void;
  autoInit?: boolean;
  exitOnKill?: boolean;
} = {}): { child: FakeChild; restore(): void } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), sent: [] as Sent[], kills: [] as Array<string | number | undefined>,
    send(message: Sent, callback: (error?: Error | null) => void) {
      this.sent.push(message);
      const fail = typeof behavior.failSend === 'function' ? behavior.failSend(message) : behavior.failSend;
      if (fail) { callback(new Error('send failed')); return; }
      callback();
      behavior.onSend?.(message, child);
      if (behavior.autoInit !== false && message.method === 'initialize') queueMicrotask(() => child.emit('message', { id: message.id, value: { ready: true } }));
    },
    kill(signal?: string | number) {
      this.kills.push(signal);
      if (behavior.exitOnKill) child.emit('exit', 1, null);
      return true;
    },
  }) as FakeChild;
  const fork = mock.method(childProcess, 'fork', () => child);
  return { child, restore: () => fork.mock.restore() };
}

test('Cursor worker model changes await IPC acknowledgment and propagate failure', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    send(message: { id: number; method: string }, callback: (error?: Error) => void) {
      callback();
      if (message.method === 'setModel') pendingModel = message.id;
      else queueMicrotask(() => child.emit('message', { id: message.id }));
    },
    kill() { return true; },
  });
  let pendingModel: number | undefined;
  const fork = mock.method(childProcess, 'fork', () => child);
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' });
    try {
      let settled = false;
      const failure = session.setModel!({ provider: 'cursor', cwd: '/tmp', model: 'bad-model' }) as Promise<void>;
      const rejected = assert.rejects(failure, /model refused/).then(() => { settled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      child.emit('message', { id: pendingModel, error: { name: 'Error', message: 'model refused' } });
      await rejected;
      const success = session.setModel!({ provider: 'cursor', cwd: '/tmp', model: 'composer-2.5' });
      child.emit('message', { id: pendingModel });
      await success;
    } finally { await session.dispose(); }
  } finally { fork.mock.restore(); }
});

test('abort before launch does not fork and abort during initialize cancels the child', async () => {
  const early = new AbortController();
  early.abort();
  const unused = mock.method(childProcess, 'fork', () => { throw new Error('forked'); });
  try {
    await assert.rejects(createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp', signal: early.signal }), { name: 'AbortError' });
    assert.equal(unused.mock.calls.length, 0);
  } finally { unused.mock.restore(); }

  const { child, restore } = installFork({ autoInit: false, exitOnKill: true });
  const controller = new AbortController();
  try {
    const pending = createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp', signal: controller.signal });
    await tick();
    assert.equal(child.sent[0]?.method, 'initialize');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(child.kills.length >= 1);
    assert.equal(child.sent.some((message) => message.method === 'run'), false);
  } finally { restore(); }
});

test('worker IPC covers transcript, terminals, identity, background updates, and both interrupt names', async () => {
  const identities: SessionSummary[] = [];
  const { child, restore } = installFork({
    onSend(message, worker) {
      if (message.method === 'transcript') queueMicrotask(() => worker.emit('message', { id: message.id, value: [{ id: 'm', role: 'user', text: 'hi' }] satisfies ChatMessage[] }));
      else if (message.method === 'terminals') queueMicrotask(() => worker.emit('message', { id: message.id, value: [{ processId: 'proc-1', command: 'sleep' }] }));
      else if (message.method === 'interruptTerminal') queueMicrotask(() => worker.emit('message', { id: message.id, value: undefined }));
      else if (message.method !== 'initialize') queueMicrotask(() => worker.emit('message', { id: message.id, value: undefined }));
    },
  });
  try {
    const session = await createCursorWorker({
      provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp', apiKey: 'secret',
      onIdentity: (summary) => identities.push(summary),
      interactions: { requestPermission: async () => 'deny', requestPlan: async () => 'rejected', requestAnswers: async () => ({}) },
    });
    try {
      const identity: SessionSummary = { id: 'sess-1', title: 'Worker', updatedAt: '2026-10-17T00:00:00.000Z', provider: 'cursor', cwd: '/tmp' };
      child.emit('message', { identity });
      child.emit('message', { noise: true });
      child.emit('message', { id: 999 });
      assert.equal(session.sessionId, 'sess-1');
      assert.equal(identities[0]?.id, 'sess-1');
      const background: AgentUpdate[] = [];
      const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
      const update = { id: 'bg', role: 'status' as const, text: 'background' };
      child.emit('message', { backgroundUpdate: update });
      unsubscribe();
      child.emit('message', { backgroundUpdate: { ...update, id: 'later' } });
      assert.deepEqual(background.map((item) => item.id), ['bg']);
      const transcript: ChatMessage[] = [];
      await session.loadTranscript!((message) => transcript.push(message));
      assert.equal(transcript[0]?.text, 'hi');
      assert.equal((await session.listBackgroundTerminals!())[0]?.processId, 'proc-1');
      await session.interruptBackgroundTerminal!('proc-1');
      await session.terminateBackgroundTerminal!('proc-1');
      await session.setMode!('plan');
      const interrupts = child.sent.filter((message) => message.method === 'interruptTerminal');
      assert.equal(interrupts.length, 2);
      assert.deepEqual(interrupts.map((message) => message.args), ['proc-1', 'proc-1']);
      assert.equal(child.sent.some((message) => message.method === 'setMode' && message.args === 'plan'), true);
      const init = child.sent.find((message) => message.method === 'initialize');
      const args = init?.args as Record<string, unknown>;
      assert.equal(args.signal, undefined);
      assert.equal(args.onIdentity, undefined);
      assert.equal(args.interactions, undefined);
      assert.equal(args.apiKey, 'secret');
      assert.equal(typeof args.cursorTerminalDataDir, 'string');
      assert.equal(session.closed, false);
    } finally { await session.dispose(); }
  } finally { restore(); }
});

test('run forwards updates and cancel, then rejects when the signal aborts after the request', async () => {
  const { child, restore } = installFork({ autoInit: true });
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' });
    try {
      const controller = new AbortController();
      const updates: AgentUpdate[] = [];
      let runId = 0;
      const original = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.method === 'run' || message.method === 'cancel' || message.method === 'dispose') {
          child.sent.push(message);
          callback();
          if (message.method === 'run') runId = message.id;
          else queueMicrotask(() => child.emit('message', { id: message.id }));
          return;
        }
        original(message, callback);
      };
      const running = session.run('hello', controller.signal, (update) => updates.push(update), undefined, { intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd: '/tmp', model: 'auto' } });
      await tick();
      child.emit('message', { update: { id: 'partial', role: 'assistant', text: 'partial' } });
      controller.abort();
      await tick();
      child.emit('message', { id: runId, value: { done: true } });
      await assert.rejects(running, { name: 'AbortError' });
      assert.equal(updates[0]?.text, 'partial');
      assert.equal(child.sent.some((message) => message.method === 'cancel'), true);
      child.emit('message', { update: { id: 'after', role: 'assistant', text: 'leaked' } });
      assert.equal(updates.some((update) => update.id === 'after'), false);
      const again = new AbortController();
      again.abort();
      await assert.rejects(session.run('late', again.signal, () => {}), { name: 'AbortError' });
      assert.equal(child.sent.some((message) => message.method === 'run' && (message.args as { prompt?: string }).prompt === 'late'), false);
    } finally { await session.dispose(); }
  } finally { restore(); }
});

test('send failure, child exit, and a closed process reject without opening another request', async () => {
  const failed = installFork({ failSend: true });
  try {
    await assert.rejects(createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' }), /send failed/);
    assert.ok(failed.child.kills.length >= 1);
  } finally { failed.restore(); }

  const exited = installFork({ autoInit: false });
  try {
    const pending = createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' });
    await tick();
    exited.child.emit('error', new Error('spawn failed'));
    await assert.rejects(pending, /SDK process exited/);
    exited.child.emit('exit', 1, null);
  } finally { exited.restore(); }

  const { child, restore } = installFork();
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' });
    child.emit('message', { id: child.sent.find((message) => message.method === 'initialize')!.id, error: { name: 'TypeError', message: 'ignored late', isRetryable: true } });
    const mode = session.setMode!('ask');
    await tick();
      const request = child.sent.filter((message) => message.method === 'setMode').at(-1)!;
    child.emit('message', { id: request.id, error: { name: 'TypeError', message: 'mode failed', isRetryable: true, operation: 'setMode' } });
      await assert.rejects(async () => { await mode; }, (error: Error & { isRetryable?: boolean; operation?: string }) => {
      assert.equal(error.message, 'mode failed');
      assert.equal(error.name, 'TypeError');
      assert.equal(error.isRetryable, true);
      assert.equal(error.operation, 'setMode');
      return true;
    });
    child.emit('exit', 0, null);
    assert.equal(session.closed, true);
    await assert.rejects(async () => { await session.setModel!({ provider: 'cursor', cwd: '/tmp', model: 'auto' }); }, /process closed/);
    const disposeCount = child.sent.filter((message) => message.method === 'dispose').length;
    const first = session.dispose();
    const second = session.dispose();
    assert.equal(first, second);
    await first;
    assert.equal(child.sent.filter((message) => message.method === 'dispose').length, disposeCount);
    assert.ok(child.kills.length >= 1);
  } finally { restore(); }
});

test('dispose still kills the child when the process exits during shutdown', async () => {
  const { child, restore } = installFork({
    onSend(message, worker) {
      if (message.method === 'dispose') worker.emit('exit', 1, null);
    },
  });
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/tmp', model: 'auto', storagePath: '/tmp' });
    const background: AgentUpdate[] = [];
    session.subscribeBackgroundUpdates!((update) => background.push(update));
    await assert.rejects(async () => { await session.dispose(); }, /SDK process exited/);
    child.emit('message', { backgroundUpdate: { id: 'after-dispose', role: 'status', text: 'gone' } });
    assert.deepEqual(background, []);
    assert.equal(session.closed, true);
    await assert.rejects(async () => { await session.dispose(); }, /SDK process exited/);
  } finally { restore(); }
});
