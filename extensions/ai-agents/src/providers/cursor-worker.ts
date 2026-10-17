import { installCursorBackgroundRuntime } from './cursor-background-runtime.js';
import { createSession } from './index.js';
import type { AgentSession, ChatMessage, Selection } from '../types.js';
import type { SessionOptions } from './session-options.js';

interface WorkerTransport {
  connected: boolean;
  on(event: 'disconnect', listener: () => void): void;
  on(event: 'message', listener: (raw: unknown) => void): void;
  send?(message: unknown): void;
  exit(): void;
}

interface BackgroundRuntime { dispose(): void }

/** Installs the SDK worker protocol against a process-like transport for testable IPC behavior. */
export function attachCursorWorker(
  worker: WorkerTransport,
  factory: typeof createSession = createSession,
  backgroundRuntime: BackgroundRuntime = installCursorBackgroundRuntime(),
): void {
  let session: AgentSession | undefined;
  let abort: AbortController | undefined;
  worker.on('disconnect', () => {
    backgroundRuntime.dispose();
    abort?.abort();
    void session?.dispose().finally(() => worker.exit());
  });
  worker.on('message', async (raw) => {
    const request = raw && typeof raw === 'object' ? raw as { id?: number; method?: string; args?: any } : {};
    const { id, method, args } = request;
    const send = (value: unknown) => { if (worker.connected) worker.send?.(value); };
    try {
      let value: unknown;
      switch (method) {
        case 'initialize':
          session = await factory({ ...args as SessionOptions, onIdentity: (identity) => send({ identity }) }, undefined, true);
          session.subscribeBackgroundUpdates?.((backgroundUpdate) => send({ backgroundUpdate }));
          break;
        case 'run':
          abort = new AbortController();
          await session!.run(args.prompt, abort.signal, (update) => send({ update }), args.extras, args.turn);
          break;
        case 'terminals': value = await session!.listBackgroundTerminals?.(); break;
        case 'interruptTerminal': await session!.interruptBackgroundTerminal?.(args as string); break;
        case 'cancel': abort?.abort(); break;
        case 'setModel':
          if (!session?.setModel) throw new Error('Cursor runtime does not support model changes.');
          await session.setModel(args as Selection);
          break;
        case 'setMode': await session!.setMode?.(args); break;
        case 'transcript': {
          const messages: ChatMessage[] = [];
          await session!.loadTranscript?.((message) => messages.push(message)); value = messages; break;
        }
        case 'dispose': backgroundRuntime.dispose(); abort?.abort(); await session?.dispose(); break;
        default: throw new Error('Unknown Cursor worker operation');
      }
      send({ id, value });
    } catch (error) {
      const e = error as Error & { isRetryable?: boolean; operation?: string };
      send({ id, error: { name: e.name, message: e.message, isRetryable: e.isRetryable, operation: e.operation } });
    }
  });
}

/** Keeps the CommonJS entry guard testable without launching a real SDK worker. */
export function startCursorWorkerIfMain(
  isMain: boolean,
  worker: WorkerTransport,
  factory?: typeof createSession,
  backgroundRuntime?: BackgroundRuntime,
): void {
  if (isMain) attachCursorWorker(worker, factory, backgroundRuntime);
}

startCursorWorkerIfMain(require.main === module, process as unknown as WorkerTransport);
