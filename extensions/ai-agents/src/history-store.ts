import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatState, SessionSummary } from './types.js';
import type { AgentControls } from './capabilities.js';
export interface SavedConversation {
  version: 1;
  id: string;
  sessionId?: string;
  updatedAt: string;
  controls: AgentControls;
  state: ChatState;
}
/** Display-only snapshots. These records are never submitted as model history. */
export class HistoryStore {
  private readonly records = new Map<string, SavedConversation>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirty = new Map<string, SavedConversation>();
  readonly errors: string[] = [];
  constructor(private readonly root: string, private readonly failed: (error: unknown) => void = () => {}) {}
  async load(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const name of names.filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
      try {
        const value = JSON.parse(await readFile(path.join(this.root, name), 'utf8')) as SavedConversation;
        if (value.version !== 1 || `${value.id}.json` !== name || !value.state?.selection || !Array.isArray(value.state.messages) || !Array.isArray(value.state.turns) || !value.controls?.backend || typeof value.updatedAt !== 'string' || typeof value.state.selection.cwd !== 'string' || !['cursor', 'codex'].includes(value.state.selection.provider) || !['sdk', 'acp', 'app-server'].includes(value.controls.backend) || !['changes', 'todos', 'sessions', 'subagents', 'terminals'].every((key) => Array.isArray((value.state as unknown as Record<string, unknown>)[key])) || !value.state.plan || !value.state.messages.every((message) => typeof message.id === 'string' && typeof message.text === 'string' && ['user', 'assistant', 'tool', 'status', 'error'].includes(message.role))) throw new Error(`Invalid history record: ${name}`);
        this.records.set(value.id, value);
      } catch { this.errors.push(`履歴を読み込めませんでした。元ファイルを保持しています: ${name}`); }
    }
  }
  get(id: string): SavedConversation | undefined { return this.records.get(id) ?? [...this.records.values()].find((r) => r.sessionId === id); }
  summaries(): SessionSummary[] {
    return [...this.records.values()].map((r) => ({
      id: r.sessionId ?? r.id, conversationId: r.id, backend: r.controls.backend,
      title: r.state.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || 'Chat',
      updatedAt: r.updatedAt, provider: r.state.selection.provider, cwd: r.state.selection.cwd,
    }));
  }
  schedule(record: SavedConversation): void {
    this.records.set(record.id, record); this.dirty.set(record.id, record);
    const previous = this.timers.get(record.id); if (previous) clearTimeout(previous);
    if (!record.state.busy) { void this.flushOne(record.id).catch(this.failed); return; }
    this.timers.set(record.id, setTimeout(() => { this.timers.delete(record.id); void this.flushOne(record.id).catch(this.failed); }, 500));
  }
  private flushOne(id: string): Promise<void> {
    const record = this.dirty.get(id)!;
    this.dirty.delete(id);
    const task = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = path.join(this.root, `${id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, path.join(this.root, `${id}.json`));
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
    });
    const recoverable = task.catch((error: unknown) => {
      if (!this.dirty.has(id)) this.dirty.set(id, record);
      throw error;
    });
    this.tails.set(id, recoverable); return recoverable;
  }
  async flush(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    const results = await Promise.allSettled([...this.dirty.keys()].map((id) => this.flushOne(id)).concat([...this.tails.values()]));
    const failure = results.find((r) => r.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
  async clear(id?: string): Promise<void> {
    await this.flush();
    for (const key of id ? [id] : [...this.records.keys()]) {
      await unlink(path.join(this.root, `${key}.json`)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      this.records.delete(key);
    }
  }
}
