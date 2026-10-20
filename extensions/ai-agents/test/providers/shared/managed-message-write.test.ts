import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { writeManagedMessage } from '../../../src/providers/managed-message-write.js';

test('managed socket writes stop after destruction or excessive queued output', () => {
  const writes: string[] = [];
  const socket = {
    destroyed: false, writableLength: 0,
    write(value: string) { writes.push(value); return true; },
    destroy() { socket.destroyed = true; return socket; },
  };
  writeManagedMessage(socket as unknown as Socket, { id: 1, value: 'ready' });
  assert.deepEqual(writes, ['{"id":1,"value":"ready"}\n']);

  socket.destroyed = true;
  writeManagedMessage(socket as unknown as Socket, { id: 2 });
  assert.equal(writes.length, 1);

  socket.destroyed = false;
  socket.writableLength = 16 * 1024 * 1024 + 1;
  writeManagedMessage(socket as unknown as Socket, { id: 3 });
  assert.equal(socket.destroyed, true);
  assert.equal(writes.length, 1);
});
