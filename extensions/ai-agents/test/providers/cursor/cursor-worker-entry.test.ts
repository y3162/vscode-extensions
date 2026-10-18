import assert from 'node:assert/strict';

import childProcess, { fork } from 'node:child_process';

import fs, { type Dirent } from 'node:fs';

import path from 'node:path';

import { mock, test } from 'node:test';

import { startCursorWorkerIfMain } from '../../../src/providers/cursor-worker.js';

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
