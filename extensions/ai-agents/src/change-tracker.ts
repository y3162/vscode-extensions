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
}

export async function captureGitBaselines(cwd: string): Promise<GitBaselines | undefined> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (status === undefined) return undefined;
  const dirty = new Map<string, string | null | undefined>();
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const name = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!name || name.includes(' -> ')) continue;
    dirty.set(name, await readWorkspaceText(cwd, name));
  }
  return {
    async lookup(filePath: string) {
      const relative = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
      if (dirty.has(relative)) return dirty.get(relative);
      if (dirty.has(filePath)) return dirty.get(filePath);
      const head = await git(cwd, ['show', `HEAD:${relative.replace(/\\/g, '/')}`]);
      return head === undefined ? null : head;
    },
  };
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
