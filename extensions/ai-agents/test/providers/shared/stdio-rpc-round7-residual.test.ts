import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { StdioJsonRpc } from '../../../src/providers/stdio-rpc.js';

interface FakeProc extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  writes: string[];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeProcess(): FakeProc {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), writes: [] as string[],
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      if (signal === 'SIGKILL') { this.signalCode = 'SIGKILL'; this.exitCode = null; proc.emit('exit', null, 'SIGKILL'); }
      return true;
    },
  }) as FakeProc;
  proc.stdin.on('data', (chunk) => proc.writes.push(String(chunk)));
  return proc;
}

class SignalWithoutReason {
  aborted = false;
  readonly reason = undefined;
  readonly listeners = new Set<(event: Event) => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'abort' || !listener) return;
    this.listeners.add(typeof listener === 'function' ? listener as (event: Event) => void : (event) => listener.handleEvent(event));
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'abort' || !listener) return;
    for (const callback of this.listeners) {
      if (callback === listener || (typeof listener !== 'function' && callback.toString().includes('handleEvent'))) this.listeners.delete(callback);
    }
  }

  abort(): void {
    this.aborted = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener(new Event('abort'));
  }
}

test('stdio process exit falls back to the generic signal label when both exit fields are null', async () => {
  const proc = fakeProcess();
  const spawn = mock.method(childProcess, 'spawn', () => proc);
  const rpc = new StdioJsonRpc({ command: 'agent', args: [] });
  try {
    proc.exitCode = 0;
    proc.emit('exit', null, null);
    assert.equal(rpc.isClosed, true);
    await assert.rejects(rpc.request('after-exit', {}), /Agent process exited \(signal\)\./);
  } finally {
    await rpc.dispose();
    spawn.mock.restore();
  }
});

test('stdio abort without a reason rejects with AbortError and leaves the connection usable', async () => {
  const proc = fakeProcess();
  const spawn = mock.method(childProcess, 'spawn', () => proc);
  const rpc = new StdioJsonRpc({ command: 'agent', args: [] });
  const signal = new SignalWithoutReason();
  try {
    const pending = rpc.request('held', {}, signal as unknown as AbortSignal);
    await new Promise((resolve) => setImmediate(resolve));
    signal.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(rpc.isClosed, false);

    proc.stdout.write(JSON.stringify({ id: 1, result: { late: true } }) + '\n');
    await new Promise((resolve) => setImmediate(resolve));
    const next = rpc.request('next', {});
    await new Promise((resolve) => setImmediate(resolve));
    proc.stdout.write(JSON.stringify({ id: 2, result: { ok: true } }) + '\n');
    assert.deepEqual(await next, { ok: true });
  } finally {
    proc.exitCode = 0;
    await rpc.dispose();
    spawn.mock.restore();
  }
});
