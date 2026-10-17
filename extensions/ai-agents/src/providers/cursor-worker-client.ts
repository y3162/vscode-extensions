import { homedir } from 'node:os';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentSession, AgentUpdate, ChatMessage, SessionSummary } from '../types.js';
import type { SessionOptions } from './session-options.js';

/** The SDK resolves native helpers from argv[1], which in an Extension Host belongs to VS Code. */
export async function createCursorWorker(options: SessionOptions): Promise<AgentSession> {
  options.signal?.throwIfAborted();
  const entry = path.join(__dirname, 'cursor-worker.cjs');
  const terminalDataDir = path.join(homedir(), '.cursor');
  const backgroundListeners = new Set<(update: AgentUpdate) => void>();
  const child = fork(existsSync(entry) ? entry : path.resolve(__dirname, '../../dist/cursor-worker.cjs'), [], {
    execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
  });
  let sequence = 0;
  let closed = false;
  let disposal: Promise<void> | undefined;
  let identity: string | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let updates: ((update: AgentUpdate) => void) | undefined;
  const fail = () => {
    closed = true;
    for (const wait of pending.values()) wait.reject(new Error('Cursor SDK process exited. Diagnose the SDK runtime before retrying.'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  // Drain runtime logs without allowing them into the control channel or exposing credentials.
  child.stdout?.resume(); child.stderr?.resume();
  child.on('message', (raw) => {
    const message = raw as { id?: number; value?: unknown; error?: { name: string; message: string; isRetryable?: boolean; operation?: string }; update?: AgentUpdate; backgroundUpdate?: AgentUpdate; identity?: SessionSummary };
    if (message.identity) { identity = message.identity.id; options.onIdentity?.(message.identity); return; }
    if (message.backgroundUpdate) { for (const listener of backgroundListeners) listener(message.backgroundUpdate); return; }
    if (message.update) { updates?.(message.update); return; }
    const wait = message.id === undefined ? undefined : pending.get(message.id);
    if (!wait || message.id === undefined) return;
    pending.delete(message.id);
    if (message.error) wait.reject(Object.assign(new Error(message.error.message), message.error));
    else wait.resolve(message.value);
  });
  const request = (method: string, args: unknown = {}): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('Cursor SDK process closed.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, method, args }, (error) => { if (error) { pending.delete(id); reject(error); } });
    });
  };
  const abortInit = () => child.kill();
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abortInit, { once: true });
  try {
    const { onIdentity: _identity, interactions: _interactions, signal: _signal, ...serializable } = options;
    await request('initialize', { ...serializable, cursorTerminalDataDir: terminalDataDir });
  } catch (error) {
    child.kill();
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw error;
  } finally { options.signal?.removeEventListener('abort', abortInit); }
  return {
    get sessionId() { return identity; },
    subscribeBackgroundUpdates(emit) { backgroundListeners.add(emit); return () => backgroundListeners.delete(emit); },
    async listBackgroundTerminals() { return await request('terminals') as import('../types.js').TerminalRecord[]; },
    async interruptBackgroundTerminal(processId) { await request('interruptTerminal', processId); },
    async terminateBackgroundTerminal(processId) { await request('interruptTerminal', processId); },
    get closed() { return closed; },
    setModel(selection) { void request('setModel', selection).catch(() => undefined); },
    async setMode(mode) { await request('setMode', mode); },
    async loadTranscript(emit) {
      for (const message of await request('transcript') as ChatMessage[]) emit(message);
    },
    async run(prompt, signal, emit, extras, turn) {
      signal.throwIfAborted(); updates = emit;
      const cancel = () => { void request('cancel').catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try { await request('run', { prompt, extras, turn }); signal.throwIfAborted(); }
      finally { signal.removeEventListener('abort', cancel); updates = undefined; }
    },
    dispose() {
      return disposal ??= (async () => {
        try { if (!closed) await request('dispose'); }
        finally { closed = true; backgroundListeners.clear(); child.kill(); }
      })();
    },
  };
}
