import assert from 'node:assert/strict';
import childProcess, { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { type Dirent } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';
import { CursorTerminals } from '../../../src/providers/cursor-terminals.js';
import { createCursorWorker } from '../../../src/providers/cursor-worker-client.js';
import { startCursorWorkerIfMain } from '../../../src/providers/cursor-worker.js';

function log(status = 'running'): string {
  return `---\npid: 12345\ncommand: "sleep 60"\nstatus: ${status}\nstarted_at: 2026-10-17T00:48:02.596Z\n---\nready\n`;
}

function dirent(name: string, file: boolean, directory: boolean): Dirent {
  return { name, isFile: () => file, isDirectory: () => directory } as unknown as Dirent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('background executor remains exactly-once disposed during a reentrant worker cleanup', () => {
  const runtime = new CursorBackgroundRuntime();
  const shells = new Map([[7, { pid: 700 }]]);
  let disposeCalls = 0;
  const executor = {
    getManager: () => ({ runningShells: shells, abort: () => false }),
    dispose() { disposeCalls += 1; runtime.dispose(); },
  };

  runtime.release(executor);
  runtime.dispose();
  assert.equal(disposeCalls, 1, 'a dispose callback that re-enters runtime cleanup is still called once');
  assert.equal(runtime.interrupt(7, 700), false, 'disposing clears the retained executor');
});

test('terminal polling reschedules after a run while a claimed shell remains running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-schedule-'));
  const folder = path.join(root, 'projects', 'workspace', 'terminals');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '123.txt'), log());
  let reads = 0;
  const readDirectory = async (directory: string, options: { withFileTypes: true }) => {
    reads += 1;
    return readdir(directory, options);
  };
  const monitor = new CursorTerminals(root, () => {}, async () => true, undefined, undefined, undefined, readDirectory);
  try {
    monitor.start();
    await monitor.finishRun(); // A running SDK process keeps polling even though the turn is over.
    const afterFinish = reads;
    await delay(150);
    const afterFirstScheduledRead = reads;
    assert.ok(afterFirstScheduledRead > afterFinish, 'the pending poll refreshes terminal records');
    await delay(150);
    assert.ok(reads > afterFirstScheduledRead, 'a still-running claimed shell schedules another refresh');
  } finally {
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal polling reschedules across two intervals while a run remains active', async () => {
  let reads = 0;
  const monitor = new CursorTerminals('/unused', () => {}, async () => true, undefined, undefined, undefined, async () => {
    reads += 1;
    return [];
  });
  try {
    monitor.start();
    const beforePolling = reads;
    await delay(150);
    const afterFirstInterval = reads;
    await delay(150);
    const afterSecondInterval = reads;
    assert.ok(afterFirstInterval > beforePolling, 'active run performs the first scheduled refresh');
    assert.ok(afterSecondInterval > afterFirstInterval, 'active run schedules another refresh without running terminal records');
  } finally {
    monitor.dispose();
  }
});

test('terminal polling stops after the pending refresh when inactive with no running records', async () => {
  let reads = 0;
  const monitor = new CursorTerminals('/unused', () => {}, async () => true, undefined, undefined, undefined, async () => {
    reads += 1;
    return [];
  });
  try {
    monitor.start();
    await delay(150);
    await monitor.finishRun();
    const afterFinish = reads;
    await delay(150);
    const afterPendingRefresh = reads;
    await delay(150);
    const afterWouldBeReschedule = reads;
    assert.ok(afterPendingRefresh > afterFinish, 'the already scheduled refresh runs after the turn finishes');
    assert.equal(afterWouldBeReschedule, afterPendingRefresh, 'inactive monitor with no running records does not schedule a third refresh');
  } finally {
    monitor.dispose();
  }
});

test('terminal scan ignores non-files and malformed names before opening log paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-filenames-'));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, 'workspace', 'terminals');
  await mkdir(folder, { recursive: true });
  const readDirectory = async (directory: string, _options: { withFileTypes: true }): Promise<Dirent[]> => {
    if (directory === projects) return [dirent('workspace', false, true)];
    if (directory === folder) return [
      dirent('9.txt', false, false),
      dirent('notes.txt', true, false),
      dirent('10.TXT', true, false),
      dirent('12.txt.bak', true, false),
    ];
    throw new Error(`unexpected directory: ${directory}`);
  };
  const updates: unknown[] = [];
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => true, undefined, undefined, undefined, readDirectory);
  try {
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(updates.some((update) => (update as { tool?: unknown }).tool !== undefined), false);
    assert.deepEqual((updates.at(-1) as { meta?: { terminals?: unknown[] } })?.meta?.terminals, []);
  } finally {
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker client selects a present sibling entry and completes synthetic initialization IPC', async () => {
  const expectedEntry = path.resolve(__dirname, '../../../src/providers/cursor-worker.cjs');
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    send(message: { id: number; method: string }, callback: (error?: Error | null) => void) {
      callback();
      queueMicrotask(() => child.emit('message', { id: message.id, value: undefined }));
    },
    kill() { return true; },
  });
  const exists = mock.method(fs, 'existsSync', (file: fs.PathLike) => String(file) === expectedEntry);
  const forkSpy = mock.method(childProcess, 'fork', () => child as unknown as ReturnType<typeof fork>);
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/workspace', model: 'auto', storagePath: '/tmp' });
    try {
      assert.equal(forkSpy.mock.calls[0]?.arguments[0], expectedEntry);
      assert.equal(exists.mock.calls.some((call) => String(call.arguments[0]) === expectedEntry), true);
      assert.equal(session.closed, false);
    } finally {
      await session.dispose();
    }
  } finally {
    forkSpy.mock.restore();
    exists.mock.restore();
  }
});

test('worker client falls back to dist entry when the sibling worker is absent', async () => {
  const siblingEntry = path.resolve(__dirname, '../../../src/providers/cursor-worker.cjs');
  const fallbackEntry = path.resolve(__dirname, '../../../dist/cursor-worker.cjs');
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    send(message: { id: number; method: string }, callback: (error?: Error | null) => void) {
      callback();
      queueMicrotask(() => child.emit('message', { id: message.id, value: { initialized: true } }));
    },
    kill() { return true; },
  });
  const exists = mock.method(fs, 'existsSync', (file: fs.PathLike) => {
    assert.equal(String(file), siblingEntry, 'only the source-adjacent candidate is tested');
    return false;
  });
  const forkSpy = mock.method(childProcess, 'fork', () => child as unknown as ReturnType<typeof fork>);
  try {
    const session = await createCursorWorker({ provider: 'cursor', cwd: '/workspace', model: 'auto', storagePath: '/tmp' });
    try {
      assert.equal(forkSpy.mock.calls[0]?.arguments[0], fallbackEntry);
      assert.equal(child.listenerCount('message') > 0, true, 'the synthetic child participates in worker IPC');
      assert.equal(exists.mock.calls.length, 1);
    } finally {
      await session.dispose();
    }
  } finally {
    forkSpy.mock.restore();
    exists.mock.restore();
  }
});

test('executable Cursor worker attaches its synthetic IPC loop without initializing the SDK', async () => {
  const sourceEntry = path.resolve(__dirname, '../../../src/providers/cursor-worker.ts');
  const compiledEntry = path.resolve(__dirname, '../../../src/providers/cursor-worker.js');
  const entry = fs.existsSync(sourceEntry) ? sourceEntry : compiledEntry;
  const child = fork(entry, [], {
    execArgv: entry === sourceEntry ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const request = (id: number, method: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error(`worker request ${method} timed out`)); }, 5_000);
    const onMessage = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || (raw as { id?: number }).id !== id) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(raw as Record<string, unknown>);
    };
    child.on('message', onMessage);
    child.send({ id, method });
  });
  try {
    assert.deepEqual(await request(1, 'unknown'), {
      id: 1, error: { name: 'Error', message: 'Unknown Cursor worker operation' },
    });
    assert.deepEqual(await request(2, 'dispose'), { id: 2 }, 'IPC serialization omits the undefined result field');
  } finally {
    child.kill();
  }
});

test('Cursor worker entry guard attaches IPC only for the main module', async () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[] = [];
  const worker = {
    connected: true,
    on(event: 'disconnect' | 'message', listener: (...args: unknown[]) => void) { handlers.set(event, listener); },
    send(message: unknown) { sent.push(message); },
    exit() {},
  } as Parameters<typeof startCursorWorkerIfMain>[1];
  const backgroundRuntime = { dispose() {} };

  startCursorWorkerIfMain(false, worker, undefined, backgroundRuntime);
  assert.equal(handlers.size, 0, 'an imported worker module does not attach process listeners');

  startCursorWorkerIfMain(true, worker, undefined, backgroundRuntime);
  assert.equal(handlers.has('message'), true, 'the main module installs its IPC listener');
  handlers.get('message')!({ id: 7, method: 'unknown' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ id: 7, error: {
    name: 'Error', message: 'Unknown Cursor worker operation', isRetryable: undefined, operation: undefined,
  } }]);
  handlers.get('disconnect')!();
});
