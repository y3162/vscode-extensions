import { execFile } from 'node:child_process';
import { realpath, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      kind: change.kind || existing.kind,
      previousText: existing.previousText !== undefined ? existing.previousText : change.previousText,
      diff: change.diff || existing.diff,
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
    const info = await stat(resolved);
    if (!info.isFile() || info.size > maxSnapshot) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    const bytes = await readFile(resolved);
    if (bytes.includes(0)) {
      store.set(resolved, { path: resolved, kind: 'update' });
      return;
    }
    store.set(resolved, { path: resolved, kind: 'update', previousText: bytes.toString('utf8') });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      store.set(resolved, { path: resolved, kind: 'add', previousText: null });
      return;
    }
    store.set(resolved, { path: resolved, kind: 'update' });
  }
}

async function realInside(candidate: string, roots: string[]): Promise<boolean> {
  if (!isInsideWorkspace(candidate, roots)) return false;
  const realRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => path.resolve(root))));
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return isInsideWorkspace(await realpath(current), realRoots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
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
  const resolved = path.resolve(change.path);
  if (!await realInside(resolved, roots)) throw new Error('ワークスペース外のファイルは変更できません。');
  if (change.previousText === null) {
    await rm(resolved, { force: true });
    return;
  }
  if (typeof change.previousText === 'string') {
    await writeFile(resolved, change.previousText, 'utf8');
    return;
  }
  if (!change.diff) throw new Error('変更前の内容が無いため、このファイルは復元できません。');
  const root = roots.find((item) => isInsideWorkspace(resolved, [item])) ?? roots[0];
  if (!root) throw new Error('ワークスペース外のファイルは変更できません。');
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
