import assert from 'node:assert/strict';

import childProcess, { fork } from 'node:child_process';

import { EventEmitter } from 'node:events';

import fs, { type Dirent } from 'node:fs';

import { PassThrough } from 'node:stream';

import path from 'node:path';

import { mock, test } from 'node:test';

import { createCursorWorker } from '../../../src/providers/cursor-worker-client.js';

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
