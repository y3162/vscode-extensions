import type { ChatController } from './chat-controller.js';
import type { AgentMode, SessionSummary } from './types.js';

export interface Conversation {
  key: string;
  controller: ChatController;
  mode: AgentMode;
}

export class SessionRegistry {
  private readonly items = new Map<string, Conversation>();
  private frontId: string;

  constructor(controller: ChatController, mode: AgentMode, key = 'front') {
    this.frontId = key;
    this.items.set(key, { key, controller, mode });
  }

  get front(): ChatController {
    return this.must(this.frontId).controller;
  }

  get frontKey(): string { return this.frontId; }

  mode(): AgentMode { return this.must(this.frontId).mode; }

  setMode(mode: AgentMode): void { this.must(this.frontId).mode = mode; }

  get(key: string): ChatController | undefined { return this.items.get(key)?.controller; }

  runningCount(): number {
    let count = 0;
    for (const entry of this.items.values()) if (entry.controller.snapshot().busy) count += 1;
    return count;
  }

  activityFor(sessionId: string): 'idle' | 'running' | 'waiting' | 'error' | undefined {
    for (const entry of this.items.values()) {
      const state = entry.controller.snapshot();
      if (entry.controller.sessionId() !== sessionId) continue;
      if (state.pendingPermission || state.pendingPlan || state.pendingQuestion) return 'waiting';
      if (state.busy || state.status === 'running' || state.status === 'cancelling' || entry.controller.hasLiveChildren() || entry.controller.hasLiveTerminals()) return 'running';
      if (state.status === 'error') return 'error';
      return 'idle';
    }
    return undefined;
  }

  findBySession(sessionId: string): Conversation | undefined {
    for (const entry of this.items.values()) if (entry.controller.sessionId() === sessionId) return entry;
    return undefined;
  }

  add(entry: Conversation): void { this.items.set(entry.key, entry); }

  focus(key: string): void {
    if (this.items.has(key)) this.frontId = key;
  }

  entries(): Conversation[] { return [...this.items.values()]; }

  liveSummaries(): SessionSummary[] {
    const rows: SessionSummary[] = [];
    for (const entry of this.items.values()) {
      const id = entry.controller.sessionId();
      if (!id) continue;
      const state = entry.controller.snapshot();
      const known = state.sessions.find((item) => item.id === id);
      const title = known?.title || state.messages.find((message) => message.role === 'user')?.text.slice(0, 80) || id;
      const activity = this.activityFor(id);
      rows.push({
        id,
        ...(known?.backend ? { backend: known.backend } : {}),
        ...(known?.conversationId ? { conversationId: known.conversationId } : {}),
        title,
        updatedAt: known?.updatedAt || new Date().toISOString(),
        provider: state.selection.provider,
        cwd: state.selection.cwd,
        activity: activity!,
      });
    }
    return rows;
  }

  *background(): Iterable<Conversation> {
    for (const entry of this.items.values()) if (entry.key !== this.frontId) yield entry;
  }

  private must(key: string): Conversation {
    const entry = this.items.get(key);
    if (!entry) throw new Error('会話が見つかりません。');
    return entry;
  }
}
