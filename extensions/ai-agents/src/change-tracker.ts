import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { lineChangeCounts } from './diff-stats.js';
import { isInsideWorkspace } from './change-review.js';
import type { FileChange } from './types.js';

const maxSnapshot = 500_000;

export async function readWorkspaceText(cwd: string, filePath: string): Promise<string | null | undefined> {
  const resolved = path.resolve(cwd, filePath);
  if (!isInsideWorkspace(resolved, [cwd])) return undefined;
  try {
    const info = await stat(resolved);
    if (!info.isFile() || info.size > maxSnapshot) return undefined;
    const bytes = await readFile(resolved);
    if (bytes.includes(0)) return undefined;
    return bytes.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
}

export interface GitBaselines {
  lookup(filePath: string): Promise<string | null | undefined>;
  changes(): Promise<FileChange[]>;
}

function statusEntries(status: string): Array<{ name: string; oldPath?: string; untracked: boolean }> {
  const parts = status.split('\0');
  const entries: Array<{ name: string; oldPath?: string; untracked: boolean }> = [];
  for (let index = 0; index < parts.length; index++) {
    const line = parts[index]!;
    if (line.length < 4) continue;
    const oldPath = /[RC]/.test(line.slice(0, 2)) ? parts[++index] : undefined;
    entries.push({ name: line.slice(3), untracked: line.startsWith('??'), ...(oldPath ? { oldPath } : {}) });
  }
  return entries;
}

export async function captureGitBaselines(cwd: string): Promise<GitBaselines | undefined> {
  const status = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;
  const revision = (await git(cwd, ['rev-parse', '--verify', 'HEAD']))?.trim();
  const dirty = new Map<string, string | null | undefined>();
  for (const { name } of statusEntries(status)) {
    dirty.set(name, await readWorkspaceText(cwd, name));
  }
  const baselines: GitBaselines = {
    async lookup(filePath: string) {
      const resolved = path.resolve(cwd, filePath);
      if (!isInsideWorkspace(resolved, [cwd])) return undefined;
      const relative = path.relative(cwd, resolved);
      if (dirty.has(relative)) return dirty.get(relative);
      if (dirty.has(filePath)) return dirty.get(filePath);
      // An absent Git object does not prove the file was absent: it could be ignored.
      // Keep such files non-restorable rather than deleting pre-existing user content.
      const text = revision ? await git(cwd, ['show', `${revision}:${relative.split(path.sep).join('/')}`]) : undefined;
      return text !== undefined && Buffer.byteLength(text, 'utf8') <= maxSnapshot && !text.includes('\0') ? text : undefined;
    },
    async changes() {
      const status = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
      if (status === undefined) return [];
      const current = new Map(statusEntries(status).map((entry) => [entry.name, entry]));
      const changes: FileChange[] = [];
      for (const name of new Set([...dirty.keys(), ...current.keys()])) {
        const entry = current.get(name);
        const before = await baselines.lookup(dirty.has(name) ? name : entry?.oldPath ?? name);
        const after = await readWorkspaceText(cwd, name);
        const renamed = Boolean(entry?.oldPath && !dirty.has(name));
        if (after === undefined || before === after && !renamed) continue;
        if (before === undefined && !entry?.untracked) continue;
        const kind = renamed ? 'rename' : after === null ? 'delete' : before === null || entry?.untracked && before === undefined ? 'add' : 'update';
        changes.push({ path: name, kind, ...(kind === 'rename' ? { oldPath: entry!.oldPath } : {}), ...(before !== undefined ? { previousText: before } : {}), ...lineChangeCounts(before ?? '', after ?? '') });
      }
      return changes;
    },
  };
  return baselines;
}

export function applyTextStats(change: FileChange, current: string | null | undefined): FileChange {
  if (change.previousText === undefined || current === undefined) {
    return change;
  }
  const before = change.previousText ?? '';
  const after = current ?? '';
  const counts = lineChangeCounts(before, after);
  const kind = change.previousText === null && current !== null ? 'add'
    : change.previousText !== null && current === null ? 'delete'
      : change.kind;
  return { ...change, kind, ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {}) };
}

export async function refreshChangeStats(cwd: string, changes: FileChange[]): Promise<FileChange[]> {
  const next: FileChange[] = [];
  for (const change of changes) {
    if (change.path === 'turn.diff' || change.path === 'patch') {
      next.push(change);
      continue;
    }
    if (change.previousText === undefined) {
      next.push(change);
      continue;
    }
    const current = await readWorkspaceText(cwd, change.path);
    next.push(applyTextStats(change, current));
  }
  return next;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 2_000_000, timeout: 8000 }, (error, stdout) => {
      if (error) resolve(undefined);
      else resolve(stdout);
    });
  });
}
