import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { AgentInteractions, AgentSession, AgentUpdate, ChatMessage, TerminalRecord, Selection, SessionSummary } from '../types.js';
import type { SessionOptions } from './session-options.js';
import type { ManagedMessage, ManagedSnapshot } from './managed-protocol.js';

/** Profile storage + canonical workspace + local conversation are all part of the owner key. */
export async function createManagedSession(options: SessionOptions): Promise<AgentSession> {
  const cwd = await realpath(options.cwd);
  const key = createHash('sha256').update(JSON.stringify([options.storagePath, cwd, options.ownerKey])).digest('hex').slice(0, 40);
  const root = path.join('/private/tmp', `ai-agents-owner-${process.getuid?.()}-${key}`);
  let created = false;
  try { await mkdir(root, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe managed directory.');
  if (created) {
    await writeFile(path.join(root, 'token'), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const entry = path.join(__dirname, 'managed-worker.cjs');
    const compiled = path.join(__dirname, 'managed-worker.js');
    const workerEntry = existsSync(entry) ? entry : existsSync(compiled) ? compiled : path.resolve(__dirname, '../../dist/managed-worker.cjs');
    const child = spawn(process.execPath, [workerEntry, root], {
      detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', () => undefined);
    child.unref();
  }
  let socket: Socket | undefined;
  const deadline = Date.now() + 8000;
  while (!socket && Date.now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = connect(path.join(root, 'control.sock'));
        candidate.once('connect', () => { candidate.removeListener('error', reject); resolve(candidate); });
        candidate.once('error', reject);
      });
    } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  if (!socket) {
    // Only reclaim an owner proven dead; never signal a PID read from disk.
    const pid = Number(await readFile(path.join(root, 'pid'), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(root, { recursive: true, force: true }); }
    }
    throw new Error('Execution owner unavailable. No prompt was replayed. Retry connection after the owner has stopped.');
  }
  const channel = socket;
  let closed = false;
  let sequence = 0;
  let current: ManagedSnapshot;
  let emitLive: ((update: AgentUpdate) => void) | undefined;
  let backendTurnId: string | undefined;
  const wakeWaiters = new Set<() => void>();
  const listeners = new Set<(update: AgentUpdate) => void>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    closed = true;
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(Object.assign(new Error('Execution owner disconnected. Execution state is unknown; reconnect without resending.'), { executionUncertain: true })); }
    pending.clear();
  };
  channel.on('error', fail); channel.on('close', fail);
  const request = (method: string, args?: unknown, token?: string): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('Execution owner connection is closed.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Execution owner response timed out. Do not resend an uncertain execution.'), { executionUncertain: true })); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      channel.write(`${JSON.stringify({ id, method, args, token })}\n`);
    });
  };
  createInterface({ input: channel, crlfDelay: Infinity }).on('line', (line) => {
    let message: ManagedMessage;
    try { message = JSON.parse(line) as ManagedMessage; } catch { channel.destroy(); return; }
    if (message.settled) { for (const wake of wakeWaiters) wake(); return; }
    if (message.identity) { options.onIdentity?.(message.identity); return; }
    if (message.interaction) {
      const interaction = message.interaction;
      const handler = options.interactions?.[interaction.method as keyof AgentInteractions] as ((args: unknown) => Promise<unknown>) | undefined;
      if (handler) void handler(interaction.args).then((value) => request('interaction', { id: interaction.id, value })).catch(() => undefined);
      return;
    }
    if (message.update) { if (message.update.backendTurnId) backendTurnId = message.update.backendTurnId; emitLive?.(message.update); return; }
    if (message.background) { for (const listener of listeners) listener(message.background); return; }
    if (message.id === undefined) return;
    const wait = pending.get(message.id);
    if (!wait) return;
    clearTimeout(wait.timer); pending.delete(message.id);
    if (message.sessionClosed && current) current.sessionClosed = true;
    if (message.error) wait.reject(new Error(message.error)); else wait.resolve(message.value);
  });
  try {
    const token = await readFile(path.join(root, 'token'), 'utf8');
    current = await request('hello', undefined, token) as ManagedSnapshot;
    const { signal: _signal, interactions: _interactions, onIdentity: _identity, ...serializable } = options;
    // A live initialized owner is reused exactly; options never replace its active execution.
    if (!current.identity) current = await request('initialize', serializable) as ManagedSnapshot;
    if (options.resumeId && current.identity?.id !== options.resumeId) throw new Error('Execution owner session does not match saved conversation.');
    if (current.identity) options.onIdentity?.(current.identity);
    backendTurnId = current.backendTurnId;
  } catch (error) { channel.destroy(); throw error; }
  const watch = async (id: string, signal: AbortSignal, emit: (update: AgentUpdate) => void): Promise<void> => {
    const delivered = new Map<string, string>();
    const deliver = (update: AgentUpdate) => {
      const key = `${update.subagentId ?? ''}:${update.id}`;
      const encoded = JSON.stringify(update);
      if (delivered.get(key) === encoded) return;
      delivered.set(key, encoded); emit(update);
    };
    emitLive = deliver;
    let cancelling = false;
    const cancel = () => { cancelling = true; void request('cancel').catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      while (true) {
        current = await request('snapshot') as ManagedSnapshot;
        if (current.run?.id !== id) throw new Error('Execution owner does not hold the requested run.');
        backendTurnId = current.backendTurnId;
        for (const update of current.run.updates) deliver(update);
        if (current.run.status !== 'running') {
          if (current.run.status === 'cancelled' || cancelling) throw Object.assign(new DOMException('Cancelled', 'AbortError'), { executionStatus: 'cancelled' });
          if (current.run.status === 'failed') throw Object.assign(new Error(current.run.error || 'Managed execution failed.'), { executionStatus: 'failed' });
          return;
        }
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(timer); wakeWaiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, 250);
          wakeWaiters.add(wake);
        });
      }
    } finally { signal.removeEventListener('abort', cancel); emitLive = undefined; }
  };
  return {
    get sessionId() { return current.identity?.id; },
    get closed() { return closed || current.sessionClosed === true; },
    latestBackendTurnId: () => backendTurnId,
    rewindUnsupportedReason: () => current.rewindUnsupportedReason,
    subscribeBackgroundUpdates(emit) { listeners.add(emit); return () => listeners.delete(emit); },
    async recoverRun(id, signal, emit, attached) {
      current = await request('snapshot') as ManagedSnapshot;
      if (current.run?.id !== id) return false;
      attached();
      await watch(id, signal, emit); return true;
    },
    async run(prompt, signal, emit, extras, turn) {
      signal.throwIfAborted();
      await request('run', { prompt, extras, turn });
      await watch(turn!.executionId!, signal, emit);
    },
    async detach() { listeners.clear(); channel.end(); channel.destroy(); },
    async dispose() { try { if (!closed) await request('dispose'); } finally { channel.destroy(); } },
    async setMode(mode) { await request('setMode', mode); },
    async setModel(selection: Selection) { await request('setModel', selection); },
    async loadTranscript(emit) { for (const message of await request('transcript') as ChatMessage[]) emit(message); },
    async listBackgroundTerminals() { return await request('terminals') as TerminalRecord[]; },
    async terminateBackgroundTerminal(id) { await request('terminateTerminal', id); },
    async interruptBackgroundTerminal(id) { await request('interruptTerminal', id); },
    async steer(text) { return await request('steer', text) as boolean; },
    async fork() { return await request('fork') as string; },
    async forkBeforeTurn(id) { return await request('forkBeforeTurn', id) as string; },
    activateFork(id) {
      if (current.identity) current.identity = { ...current.identity, id };
      void request('activateFork', id).catch(() => channel.destroy());
    },
    async listSessions() { return await request('listSessions') as SessionSummary[]; },
    async review(target, emit, signal) {
      const id = randomUUID();
      await request('review', { target, turn: { executionId: id } });
      await watch(id, signal, emit);
    },
    async compact() { await request('compact'); },
    async rateLimits() { return await request('rateLimits') as string; },
    async instructions() { return await request('instructions') as string; },
  };
}
