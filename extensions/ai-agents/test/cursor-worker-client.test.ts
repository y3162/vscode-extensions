import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { createCursorWorker } from '../src/providers/cursor-worker-client.js';

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
