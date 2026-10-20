// Owns the App Server stdio connection across Extension Host reloads.
// No prompts, options, credentials or event bodies are written to disk here.
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { AgentInteractions, AgentSession, AgentUpdate, SendExtras, TurnOptions } from '../types.js';
import { errorMessage, redactSecrets } from '../types.js';
import { createCodexAppServerSession } from './codex-app-server.js';
import type { SessionOptions } from './session-options.js';
import type { ManagedMessage, ManagedRun, ManagedSnapshot } from './managed-protocol.js';

const root = process.argv[2]!;
const socketPath = path.join(root, 'control.sock');
const clients = new Set<Socket>();
let owner: Socket | undefined;
let session: AgentSession | undefined;
let initialization: Promise<AgentSession> | undefined;
let identity: ManagedSnapshot['identity'];
let run: ManagedRun | undefined;
let abort: AbortController | undefined;
let lastDetached = Date.now();
let stopping = false;
let interactionId = 0;
let retainedBytes = 0;
const updates = new Map<string, AgentUpdate>();
const acceptedRuns = new Set<string>();
const interactions = new Map<number, { method: string; args: unknown; resolve(value: unknown): void }>();
const write = (socket: Socket, message: ManagedMessage) => {
  if (socket.destroyed) return;
  // A stalled UI must not grow the owner's memory indefinitely.
  if (socket.writableLength > 16 * 1024 * 1024) { socket.destroy(); return; }
  socket.write(`${JSON.stringify(message)}\n`);
};
const broadcast = (message: ManagedMessage) => { if (owner) write(owner, message); };
const snapshot = (): ManagedSnapshot => ({ identity: identity ? { ...identity, id: session?.sessionId ?? identity.id } : undefined, pid: process.pid, sessionClosed: session?.closed, rewindUnsupportedReason: session?.rewindUnsupportedReason?.(), backendTurnId: session?.latestBackendTurnId?.(), run: run ? { ...run, updates: [...updates.values()] } : undefined });
async function shutdown() {
  if (stopping) return;
  stopping = true;
  abort?.abort();
  for (const pending of interactions.values()) pending.resolve(undefined);
  interactions.clear();
  // dispose also closes owned subprocesses; the deadline covers a broken transport.
  const deadline = setTimeout(() => process.exit(1), 5000);
  await session?.dispose().catch(() => undefined);
  for (const client of clients) client.destroy();
  server.close();
  await rm(root, { recursive: true, force: true });
  clearTimeout(deadline);
  process.exit(0);
}
function remember(update: AgentUpdate, background = false) {
  const key = `${update.subagentId ?? ''}:${update.id}`;
  const old = updates.get(key);
  const size = Buffer.byteLength(JSON.stringify(update));
  retainedBytes += size - (old ? Buffer.byteLength(JSON.stringify(old)) : 0);
  if (retainedBytes > 16 * 1024 * 1024) {
    // Never claim successful recovery after silently dropping events.
    if (run) { run.status = 'failed'; run.error = 'Retained execution output exceeded the 16 MB recovery limit.'; }
    abort?.abort();
    return;
  }
  updates.set(key, structuredClone(update));
  broadcast(background ? { background: update } : { update });
}
function interact(method: string, args: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const id = ++interactionId;
    interactions.set(id, { method, args, resolve });
    broadcast({ interaction: { id, method, args } });
  });
}
const agentInteractions: AgentInteractions = {
  requestPermission: async (args) => await interact('requestPermission', args) as Awaited<ReturnType<AgentInteractions['requestPermission']>> ?? 'deny',
  requestPlan: async (args) => await interact('requestPlan', args) as 'accepted' | 'rejected' ?? 'rejected',
  requestAnswers: async (args) => await interact('requestAnswers', args) as Record<string, string[]> ?? {},
};
async function dispatch(method: string, raw: unknown): Promise<unknown> {
  if (method === 'initialize') {
    const options = raw as SessionOptions;
    if (options.provider !== 'codex' || options.backend !== 'app-server') throw new Error('Unsupported managed backend.');
    initialization ??= createCodexAppServerSession({ ...options, signal: undefined, interactions: agentInteractions, onIdentity(summary) { identity = summary; broadcast({ identity: summary }); } }).catch((error: unknown) => { initialization = undefined; throw error; });
    if (!session) {
      session = await initialization;
      session.subscribeBackgroundUpdates?.((update) => remember(update, true));
    }
    return snapshot();
  }
  if (method === 'snapshot') return snapshot();
  if (method === 'interaction') {
    const { id, value } = raw as { id: number; value: unknown };
    const pending = interactions.get(id);
    interactions.delete(id);
    pending?.resolve(value);
    return;
  }
  if (method === 'dispose') { setImmediate(() => { void shutdown(); }); return; }
  if (!session) throw new Error('Managed session is not initialized.');
  if (method === 'run' || method === 'review') {
    const args = raw as { prompt: string; extras?: SendExtras; turn?: TurnOptions; target?: 'uncommitted' | 'base' };
    const id = args.turn?.executionId;
    if (!id) throw new Error('A stable execution id is required.');
    if (run?.id === id) return snapshot(); // reconnect is never dispatch
    if (run?.status === 'running') throw new Error('The original execution is still running.');
    if (acceptedRuns.has(id)) throw new Error('This execution was already accepted; it cannot be dispatched again.');
    if (acceptedRuns.size >= 10000) throw new Error('Execution owner reached its run limit. Close this session before starting another.');
    acceptedRuns.add(id);
    updates.clear(); retainedBytes = 0;
    run = { id, status: 'running', updates: [] };
    abort = new AbortController();
    const current = run;
    const execution = method === 'review'
      ? session.review!(args.target!, (update) => remember(update), abort.signal)
      : session.run(args.prompt, abort.signal, (update) => remember(update), args.extras, args.turn);
    void execution.then(() => {
      if (current.status === 'running') current.status = abort?.signal.aborted ? 'cancelled' : 'completed';
    }, (error: unknown) => {
      if (current.status === 'running') {
        current.status = abort?.signal.aborted ? 'cancelled' : 'failed';
        current.error = redactSecrets(errorMessage(error));
      }
    }).finally(() => broadcast({ settled: true }));
    return snapshot();
  }
  if (method === 'cancel') { abort?.abort(); return; }
  if (method === 'transcript') { const messages: unknown[] = []; await session.loadTranscript?.((message) => messages.push(message)); return messages; }
  if (method === 'setModel') return session.setModel?.(raw as Parameters<NonNullable<AgentSession['setModel']>>[0]);
  if (method === 'setMode') return session.setMode?.(raw as Parameters<NonNullable<AgentSession['setMode']>>[0]);
  if (method === 'terminals') return session.listBackgroundTerminals?.();
  if (method === 'terminateTerminal') return session.terminateBackgroundTerminal?.(String(raw));
  if (method === 'interruptTerminal') return session.interruptBackgroundTerminal?.(String(raw));
  if (method === 'steer') return session.steer?.(String(raw));
  if (method === 'fork') return session.fork?.();
  if (method === 'forkBeforeTurn') return session.forkBeforeTurn?.(String(raw));
  if (method === 'activateFork') return session.activateFork?.(String(raw));
  if (method === 'compact') return session.compact?.();
  if (method === 'rateLimits') return session.rateLimits?.();
  if (method === 'listSessions') return session.listSessions?.();
  if (method === 'instructions') return session.instructions?.();
  throw new Error('Unsupported managed operation.');
}
const server = createServer((socket) => {
  clients.add(socket);
  let authenticated = false;
  const handshake = setTimeout(() => socket.destroy(), 3000);
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > (authenticated ? 24 * 1024 * 1024 : 1024)) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  });
  function handleLine(line: string) {
    if (line.length > 24 * 1024 * 1024) { socket.destroy(); return; }
    let message: ManagedMessage;
    try { message = JSON.parse(line) as ManagedMessage; } catch { socket.destroy(); return; }
    if (!authenticated) {
      const supplied = Buffer.from(message.token ?? '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token) || owner) { socket.destroy(); return; }
      authenticated = true; owner = socket; clearTimeout(handshake);
      write(socket, { id: message.id, value: snapshot() });
      for (const [id, pending] of interactions) write(socket, { interaction: { id, method: pending.method, args: pending.args } });
      return;
    }
    void dispatch(message.method ?? '', message.args).then((value) => write(socket, { id: message.id, value }), (error: unknown) => write(socket, { id: message.id, error: redactSecrets(errorMessage(error)), sessionClosed: session?.closed }));
  }
  socket.on('error', () => socket.destroy());
  socket.on('close', () => { clearTimeout(handshake); clients.delete(socket); if (owner === socket) { owner = undefined; lastDetached = Date.now(); } });
});
let token: Buffer;
async function main() {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe managed directory.');
  token = Buffer.from(await readFile(path.join(root, 'token'), 'utf8'));
  await writeFile(path.join(root, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
  server.listen(socketPath, () => { void chmod(socketPath, 0o600); });
  // Disconnected executions get a bounded grace period. No indefinite daemon.
  setInterval(() => {
    if (!owner && Date.now() - lastDetached > 10 * 60_000) void shutdown();
  }, 1000);
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}
void main().catch(() => { process.exit(1); });
