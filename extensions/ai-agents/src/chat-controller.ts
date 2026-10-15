import { randomUUID } from 'node:crypto';
import { errorMessage, type AgentSession, type ChatState, type Selection } from './types.js';

type SessionFactory = (selection: Selection) => Promise<AgentSession>;

export class ChatController {
  private session?: AgentSession;
  private active?: { abort: AbortController; done: Promise<void> };
  private resetting?: Promise<void>;
  private readonly state: ChatState;

  constructor(
    selection: Selection,
    private readonly factory: SessionFactory,
    private readonly changed: (state: ChatState) => void,
  ) {
    this.state = { selection: { ...selection }, busy: false, messages: [] };
  }

  snapshot(): ChatState { return structuredClone(this.state); }

  private publish(): void { this.changed(this.snapshot()); }

  async select(selection: Selection): Promise<void> {
    // A send can follow a dropdown change before its asynchronous cleanup finishes.
    while (this.resetting) await this.resetting;
    if (this.active) throw new Error('実行が終わってからエージェントを切り替えてください。');
    const current = this.state.selection;
    if (current.provider === selection.provider && current.cwd === selection.cwd && current.model === selection.model) return;
    await this.reset();
    this.state.selection = { ...selection };
    this.publish();
  }

  async send(prompt: string): Promise<void> {
    prompt = prompt.trim();
    if (!prompt) return;
    if (this.active || this.resetting) throw new Error('エージェントは実行中です。');
    const turnId = randomUUID();
    const operation = { abort: new AbortController(), done: Promise.resolve() };
    this.active = operation;
    this.state.busy = true;
    this.state.messages.push({ id: turnId, role: 'user', text: prompt });
    this.publish();
    operation.done = (async () => {
      try {
        this.session ??= await this.factory({ ...this.state.selection });
        operation.abort.signal.throwIfAborted();
        await this.session.run(prompt, operation.abort.signal, (update) => {
          if (operation.abort.signal.aborted) return;
          const id = `${turnId}:${update.id}`;
          const message = { ...update, id, text: update.text.slice(0, 32000) };
          const existing = this.state.messages.findIndex((item) => item.id === id);
          if (existing < 0) this.state.messages.push(message);
          else this.state.messages[existing] = message;
          this.state.messages = this.state.messages.slice(-300);
          this.publish();
        });
        if (operation.abort.signal.aborted) this.addStatus('停止しました。');
      } catch (error) {
        const cancelled = operation.abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        this.state.messages.push({
          id: randomUUID(), role: cancelled ? 'status' : 'error',
          text: cancelled ? '停止しました。' : errorMessage(error),
        });
      } finally {
        this.active = undefined;
        this.state.busy = Boolean(this.resetting);
        this.publish();
      }
    })();
    await operation.done;
  }

  stop(): void {
    if (this.active && !this.active.abort.signal.aborted) {
      this.active.abort.abort();
      this.addStatus('停止中…');
    }
  }

  private addStatus(text: string): void {
    this.state.messages.push({ id: randomUUID(), role: 'status', text });
    this.publish();
  }

  reset(): Promise<void> {
    if (this.resetting) return this.resetting;
    this.stop();
    this.state.busy = true;
    this.publish();
    this.resetting = (async () => {
      try {
        await this.active?.done;
        const session = this.session;
        this.session = undefined;
        await session?.dispose();
        this.state.messages = [];
      } finally {
        this.resetting = undefined;
        this.state.busy = false;
        this.publish();
      }
    })();
    return this.resetting;
  }

  async dispose(): Promise<void> { await this.reset(); }
}
