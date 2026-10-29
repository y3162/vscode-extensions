import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { lineChangeCounts, previewTextDiff } from './diff-stats.js';
import { isInsideWorkspace } from './change-review.js';
import { contentDigest } from './review-acceptance.js';
import type { FileChange } from './types.js';

const maxSnapshot = 500_000;

export interface WorkspaceFileSystem {
  lstat(file: string): Promise<Stats>;
  readFile(file: string): Promise<Buffer>;
}

const workspaceFiles: WorkspaceFileSystem = { lstat, readFile };

export async function readWorkspaceText(cwd: string, filePath: string, files: WorkspaceFileSystem = workspaceFiles): Promise<string | null | undefined> {
  const resolved = path.resolve(cwd, filePath);
  if (!isInsideWorkspace(resolved, [cwd])) return undefined;
  try {
    const info = await files.lstat(resolved);
    if (!info.isFile() || info.size > maxSnapshot) return undefined;
    const bytes = await files.readFile(resolved);
    if (bytes.length > maxSnapshot || bytes.includes(0)) return undefined;
    const text = bytes.toString('utf8');
    return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
}

export interface GitBaselines {
  lookup(filePath: string): Promise<string | null | undefined>;
  lookupMode(filePath: string): Promise<number | null | undefined>;
  changes(): Promise<FileChange[]>;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string | undefined>;

async function readWorkspaceMode(cwd: string, filePath: string, files: WorkspaceFileSystem): Promise<number | null | undefined> {
  const resolved = path.resolve(cwd, filePath);
  if (!isInsideWorkspace(resolved, [cwd])) return undefined;
  try {
    const info = await files.lstat(resolved);
    if (!info.isFile()) return undefined;
    return info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
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

export async function captureGitBaselines(
  cwd: string,
  runGit: GitRunner = git,
  files: WorkspaceFileSystem = workspaceFiles,
): Promise<GitBaselines | undefined> {
  const status = await runGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;
  const revision = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD']))?.trim();
  const dirty = new Map<string, string | null | undefined>();
  const dirtyModes = new Map<string, number | null | undefined>();
  for (const { name } of statusEntries(status)) {
    dirty.set(name, await readWorkspaceText(cwd, name, files));
    dirtyModes.set(name, await readWorkspaceMode(cwd, name, files));
  }
  const baselines: GitBaselines = {
    async lookup(filePath: string) {
      const resolved = path.resolve(cwd, filePath);
      if (!isInsideWorkspace(resolved, [cwd])) return undefined;
      const relative = path.relative(cwd, resolved);
      if (dirty.has(relative)) return dirty.get(relative);
      // An absent Git object does not prove the file was absent: it could be ignored.
      // Keep such files non-restorable rather than deleting pre-existing user content.
      const text = revision ? await runGit(cwd, ['show', `${revision}:${relative.split(path.sep).join('/')}`]) : undefined;
      return text !== undefined && Buffer.byteLength(text, 'utf8') <= maxSnapshot && !text.includes('\0') ? text : undefined;
    },
    async lookupMode(filePath: string) {
      const resolved = path.resolve(cwd, filePath);
      if (!isInsideWorkspace(resolved, [cwd])) return undefined;
      const relative = path.relative(cwd, resolved);
      if (dirtyModes.has(relative)) return dirtyModes.get(relative);
      if (!revision) return undefined;
      const row = await runGit(cwd, ['ls-tree', '-z', revision, '--', relative.split(path.sep).join('/')]);
      const first = row?.replace(/\0.*$/s, '');
      const [metadata, listedPath] = first?.split('\t') ?? [];
      const mode = metadata?.split(' ')[0];
      if (listedPath !== relative.split(path.sep).join('/') || (mode !== '100644' && mode !== '100755')) return undefined;
      return Number.parseInt(mode, 8) & 0o777;
    },
    async changes() {
      const status = await runGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
      if (status === undefined) return [];
      const current = new Map(statusEntries(status).map((entry) => [entry.name, entry]));
      const changes: FileChange[] = [];
      for (const name of new Set([...dirty.keys(), ...current.keys()])) {
        const entry = current.get(name);
        const baselinePath = dirty.has(name) ? name : entry?.oldPath ?? name;
        const before = entry?.untracked && !dirty.has(name) ? null : await baselines.lookup(baselinePath);
        const after = await readWorkspaceText(cwd, name, files);
        const beforeMode = entry?.untracked && !dirtyModes.has(name) ? null : await baselines.lookupMode(dirtyModes.has(name) ? name : entry?.oldPath ?? name);
        const afterMode = await readWorkspaceMode(cwd, name, files);
        const renamed = Boolean(entry?.oldPath && !dirty.has(name));
        if (after !== undefined && before === after && beforeMode === afterMode && !renamed) continue;
        if (before === undefined && !entry?.untracked && after !== undefined) continue;
        const kind = renamed ? 'rename' : after === null ? 'delete' : before === null || entry?.untracked && before === undefined ? 'add' : 'update';
        const preview = before !== undefined && after !== undefined ? previewTextDiff(before, after) : [];
        changes.push({
          path: name, kind,
          ...(kind === 'rename' ? { oldPath: entry!.oldPath } : {}),
          ...(before !== undefined ? { previousText: before } : {}),
          ...(beforeMode !== undefined ? { previousMode: beforeMode } : {}),
          ...(afterMode !== undefined ? { mode: afterMode } : {}),
          ...(preview.length ? { preview } : {}),
          ...(after !== undefined ? lineChangeCounts(before ?? '', after ?? '') : {}),
          ...(after === undefined ? {} : { observedDigest: after === null ? null : contentDigest(after) }),
        });
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
  const preview = previewTextDiff(change.previousText, current);
  return { ...change, kind, ...(preview.length ? { preview } : {}), ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {}) };
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
    const stats = applyTextStats(change, current);
    if (change.observedDigest !== undefined) next.push({ ...stats, observedDigest: change.observedDigest });
    else if (current === undefined) next.push(stats);
    else next.push({ ...stats, observedDigest: current === null ? null : contentDigest(current) });
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
