import type { Socket } from 'node:net';
import type { ManagedMessage } from './managed-protocol.js';

/** Bound queued socket output when a detached or stalled client stops reading. */
export function writeManagedMessage(socket: Socket, message: ManagedMessage): void {
  if (socket.destroyed) return;
  if (socket.writableLength > 16 * 1024 * 1024) { socket.destroy(); return; }
  socket.write(`${JSON.stringify(message)}\n`);
}
