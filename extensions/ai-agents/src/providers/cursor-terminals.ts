import { execFile } from 'node:child_process';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentUpdate, TerminalRecord } from '../types.js';

interface CursorTerminal extends TerminalRecord { pid?: number; startedAt: string }

export function parseCursorTerminal(id: string, text: string): CursorTerminal | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return;
  const fields = new Map(match[1]!.split(/\r?\n/).map((line) => {
    const index = line.indexOf(':'); return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  const rawCommand = fields.get('command');
  const startedAt = fields.get('started_at');
  if (!rawCommand || !startedAt || !Number.isFinite(Date.parse(startedAt))) return;
  let command: string;
  try { command = JSON.parse(rawCommand) as string; } catch { return; }
  if (typeof command !== 'string') return;
  const rawStatus = fields.get('status') ?? 'unknown';
  const status = rawStatus === 'succeeded' ? 'completed' : rawStatus === 'aborted' ? 'cancelled' : rawStatus === 'failed' ? 'failed' : rawStatus === 'running' ? 'running' : 'unknown';
  const pid = Number(fields.get('pid'));
  const exit = /(?:^|\r?\n)---\r?\nexit_code: (-?\d+)/.exec(match[2]!);
  return { processId: id, itemId: `cursor-terminal:${id}`, command, status, startedAt,
    ...(Number.isSafeInteger(pid) && pid > 1 ? { pid } : {}),
    output: match[2]!, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
}

async function ownsProcess(pid: number): Promise<boolean> {
  const ps = promisify(execFile);
  let parent = pid;
  try {
    for (let depth = 0; depth < 20 && parent > 1; depth++) {
      const { stdout } = await ps('/bin/ps', ['-o', 'ppid=', '-p', String(parent)]);
      parent = Number(stdout.trim());
      if (parent === process.pid) return true;
    }
  } catch { /* An exited process cannot establish ownership. */ }
  return false;
}

/** Claims SDK log files only while their process is a descendant of this worker. */
export class CursorTerminals {
  private readonly records = new Map<string, CursorTerminal>();
  private signature = '';
  private readonly ignored = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private active = false;
  private pending: Promise<TerminalRecord[]> = Promise.resolve([]);

  constructor(private readonly dataDir: string, private readonly emit: (update: AgentUpdate) => void,
    private readonly owns: (pid: number) => Promise<boolean> = ownsProcess, private readonly workspace?: string, private readonly nativeInterrupt?: (shellId: number, pid: number) => boolean) {}

  start(): void { this.active = true; this.schedule(); }

  async finishRun(): Promise<void> { this.active = false; await this.refresh(); }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => {}).finally(() => {
        if (this.active || [...this.records.values()].some((row) => row.status === 'running')) this.schedule();
      });
    }, 100);
    this.timer.unref();
  }

  refresh(): Promise<TerminalRecord[]> {
    const read = this.pending.catch(() => []).then(() => this.scan()).catch((error: unknown) => {
      if (!this.disposed) this.emit({ id: 'cursor-terminals', role: 'status', text: '', meta: {
        type: 'terminals', terminals: [...this.records.values()].map((row) => ({ ...row, status: 'unknown' })),
        terminalError: error instanceof Error ? error.message : String(error),
      } });
      throw error;
    });
    this.pending = read;
    return read;
  }

  private async scan(): Promise<TerminalRecord[]> {
    if (this.disposed) return [];
    const projects = path.join(this.dataDir, 'projects');
    const directories = await readdir(projects, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const next = new Map<string, CursorTerminal>();
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      if (this.workspace && directory.name !== this.workspace.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')) continue;
      const folder = path.join(projects, directory.name, 'terminals');
      const folderInfo = await lstat(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!folderInfo?.isDirectory()) continue;
      const files = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []; throw error;
      });
      for (const file of files) {
        if (!file.isFile() || !/^\d+\.txt$/.test(file.name)) continue;
        const handle = await open(path.join(folder, file.name), 'r');
        let text: string;
        try {
          const buffer = Buffer.alloc(256 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, bytesRead).toString('utf8');
          const info = await handle.stat();
          if (info.size > buffer.length) {
            const headerEnd = text.indexOf('\n---\n', 4);
            if (headerEnd >= 0) {
              const tail = Buffer.alloc(240 * 1024);
              const result = await handle.read(tail, 0, tail.length, Math.max(0, info.size - tail.length));
              text = text.slice(0, headerEnd + 5) + '[Earlier output omitted]\n' + tail.subarray(0, result.bytesRead).toString('utf8');
            }
          }
        } finally { await handle.close(); }
        const id = `${directory.name}/${file.name}`;
        const row = parseCursorTerminal(id, text);
        if (!row) continue; // A partially written header is retried on the next poll.
        const claimed = this.records.get(id);
        if (claimed && (claimed.pid !== row.pid || claimed.startedAt !== row.startedAt)) continue;
        if (!claimed) {
          const identity = `${id}:${row.pid}:${row.startedAt}`;
          if (row.status !== 'running' || !row.pid || this.ignored.has(identity)) continue;
          if (!await this.owns(row.pid)) { this.ignored.add(identity); continue; }
        }
        next.set(id, row);
      }
    }
    if (this.disposed) return [];
    for (const [id, row] of next) {
      if (JSON.stringify(row) === JSON.stringify(this.records.get(id))) continue;
      this.emit({ id: row.itemId!, role: 'tool', text: [row.command, row.output].filter(Boolean).join('\n'),
        tool: { name: 'shell', kind: 'shell', status: row.status === 'running' || row.status === 'unknown' ? 'running' : row.status === 'completed' ? 'completed' : 'error', ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}) } });
      this.records.set(id, row);
    }
    const rows = [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // Retain finished entries so a fast SDK cancellation is visible after the turn ends.
    const signature = JSON.stringify(rows);
    if (signature !== this.signature) {
      this.signature = signature;
      this.emit({ id: 'cursor-terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: rows } });
    }
    return rows;
  }

  async interrupt(id: string): Promise<void> {
    await this.refresh();
    const row = this.records.get(id);
    if (!row || row.status !== 'running' || !row.pid) throw new Error('このバックグラウンドターミナルは終了しています。');
    const shellId = Number(path.basename(id, '.txt'));
    if (Number.isSafeInteger(shellId) && this.nativeInterrupt?.(shellId, row.pid)) return;
    // A log-provided PID alone is insufficient: re-check worker ancestry before signalling.
    if (!await this.owns(row.pid)) throw new Error('このワーカーに所属するプロセスと確認できないため、停止できません。');
    try { process.kill(-row.pid, 'SIGINT'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      process.kill(row.pid, 'SIGINT');
    }
  }

  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); }
}
