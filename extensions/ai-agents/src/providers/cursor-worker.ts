import { installCursorBackgroundRuntime } from './cursor-background-runtime.js';
import { createSession } from './index.js';
import type { AgentSession, ChatMessage, Selection } from '../types.js';
import type { SessionOptions } from './session-options.js';
const backgroundRuntime = installCursorBackgroundRuntime();
let session: AgentSession | undefined;
let abort: AbortController | undefined;
process.on('disconnect', () => { backgroundRuntime.dispose(); abort?.abort(); void session?.dispose().finally(() => process.exit()); });
process.on('message', async (raw) => {
  const { id, method, args } = raw as { id: number; method: string; args: any };
  const send = (value: unknown) => { if (process.connected) process.send?.(value); };
  try {
    let value: unknown;
    switch (method) {
      case 'initialize':
        session = await createSession({ ...args as SessionOptions, onIdentity: (identity) => send({ identity }) }, undefined, true);
        session.subscribeBackgroundUpdates?.((backgroundUpdate) => send({ backgroundUpdate }));
        break;
      case 'run':
        abort = new AbortController();
        await session!.run(args.prompt, abort.signal, (update) => send({ update }), args.extras, args.turn);
        break;
      case 'terminals': value = await session!.listBackgroundTerminals?.(); break;
      case 'interruptTerminal': await session!.interruptBackgroundTerminal?.(args as string); break;
      case 'cancel': abort?.abort(); break;
      case 'setModel': session!.setModel?.(args as Selection); break;
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
