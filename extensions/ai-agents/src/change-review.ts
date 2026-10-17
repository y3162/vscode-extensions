import { execFile } from 'node:child_process';
import { chmod, lstat, realpath, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileChange } from './types.js';

const maxSnapshot = 500_000;

export function isInsideWorkspace(candidate: string, roots: string[]): boolean {
  const target = path.resolve(candidate);
  return roots.some((root) => {
    const base = path.resolve(root);
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function mergeFileChanges(current: FileChange[], incoming: FileChange[]): FileChange[] {
  const next = current.map((change) => ({ ...change }));
  for (const change of incoming) {
    const index = next.findIndex((item) => item.path === change.path);
    if (index < 0) {
      next.push({ ...change });
      continue;
    }
    const existing = next[index]!;
    next[index] = {
      ...existing,
      kind: existing.kind === 'rename' && change.kind === 'update' ? 'rename' : change.kind || existing.kind,
      ...(change.oldPath ? { oldPath: existing.oldPath ?? change.oldPath } : {}),
      previousText: existing.previousText !== undefined ? existing.previousText : change.previousText,
      previousMode: existing.previousMode !== undefined ? existing.previousMode : change.previousMode,
      mode: change.mode !== undefined ? change.mode : existing.mode,
      diff: change.diff || existing.diff,
      preview: change.preview?.length ? change.preview : existing.preview,
      additions: change.additions ?? existing.additions,
      deletions: change.deletions ?? existing.deletions,
    };
  }
  return next;
}

export async function captureBaseline(cwd: string, filePath: string, store: Map<string, FileChange>): Promise<void> {
  const resolved = path.resolve(cwd, filePath);
  if (!isInsideWorkspace(resolved, [cwd]) || store.has(resolved)) return;
  try {
    if (!await isRealPathInsideWorkspace(resolved, [cwd])) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxSnapshot) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    const bytes = await readFile(resolved);
    if (bytes.includes(0)) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    store.set(resolved, { path: resolved, kind: 'update', previousText: text, previousMode: info.mode & 0o777 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      store.set(resolved, { path: resolved, kind: 'add', previousText: null });
      return;
    }
    store.set(resolved, { path: resolved, kind: 'update' });
  }
}

export async function isRealPathInsideWorkspace(
  candidate: string,
  roots: string[],
  resolveRealpath: (file: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (!isInsideWorkspace(candidate, roots)) return false;
  const realRoots = await Promise.all(roots.map(async (root) => resolveRealpath(root).catch(() => path.resolve(root))));
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return isInsideWorkspace(await resolveRealpath(current), realRoots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

function resolveWorkspacePath(rawPath: string, roots: string[]): string {
  const candidates = path.isAbsolute(rawPath) ? [path.resolve(rawPath)] : roots.map((root) => path.resolve(root, rawPath));
  const resolved = candidates.find((candidate) => roots.some((root) => isInsideWorkspace(candidate, [root])));
  if (!resolved) throw new Error('ワークスペース外のファイルは変更できません。');
  return resolved;
}

function diffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    const name = line.slice(4).trim().replace(/^[ab]\//, '');
    if (name && name !== '/dev/null') paths.push(name);
  }
  return paths;
}

export async function revertChange(change: FileChange, roots: string[]): Promise<void> {
  const resolved = resolveWorkspacePath(change.path, roots);
  if (!await isRealPathInsideWorkspace(resolved, roots)) throw new Error('ワークスペース外のファイルは変更できません。');
  if (change.kind === 'rename') {
    if (!change.oldPath || typeof change.previousText !== 'string') throw new Error('変更前のパスと内容が無いため、この移動は復元できません。');
    // resolveWorkspacePath above only returns a path inside one of these roots.
    const root = roots.find((item) => isInsideWorkspace(resolved, [item]))!;
    const original = resolveWorkspacePath(change.oldPath, [root]);
    if (!await isRealPathInsideWorkspace(original, roots)) throw new Error('ワークスペース外のファイルは変更できません。');
    // Never replace a user-created file at the original name.
    await writeFile(original, change.previousText, { encoding: 'utf8', flag: 'wx', mode: change.previousMode ?? 0o666 });
    if (change.previousMode !== undefined && change.previousMode !== null) await chmod(original, change.previousMode);
    await rm(resolved);
    return;
  }
  if (change.previousText === null) {
    await rm(resolved, { force: true });
    return;
  }
  if (typeof change.previousText === 'string') {
    const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.ai-agents-revert-${randomUUID()}.tmp`);
    let mode = change.previousMode ?? 0o666;
    try {
      try {
        const current = await lstat(resolved);
        if (!current.isFile() || current.isSymbolicLink()) throw new Error('Revert は通常ファイルにのみ適用できます。');
        if (change.previousMode === undefined || change.previousMode === null) mode = current.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFile(temporary, change.previousText, { encoding: 'utf8', flag: 'wx', mode: change.previousMode ?? 0o666 });
      await chmod(temporary, mode);
      await rename(temporary, resolved);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    return;
  }
  if (!change.diff) throw new Error('変更前の内容が無いため、このファイルは復元できません。');
  // resolveWorkspacePath above only returns a path inside one of these roots.
  const root = roots.find((item) => isInsideWorkspace(resolved, [item]))!;
  await gitApplyReverse(change.diff, path.resolve(root), roots);
}

export async function gitApplyReverse(diff: string, root: string, roots: string[]): Promise<void> {
  if (!diff.trim()) throw new Error('変更前の内容が無いため、このファイルは復元できません。');
  for (const name of diffPaths(diff)) {
    if (!isInsideWorkspace(path.resolve(root, name), roots)) throw new Error('ワークスペース外のファイルは変更できません。');
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['apply', '--reverse', '--whitespace=nowarn', '-'], { cwd: root, maxBuffer: 2_000_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end(diff);
  });
}
