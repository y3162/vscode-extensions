import type { FileChange } from './types.js';

const maxLines = 4000;

export function lineChangeCounts(before: string, after: string): { additions: number; deletions: number } | undefined {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length > maxLines || right.length > maxLines) return undefined;
  const shared = lcsLength(left, right);
  return { additions: right.length - shared, deletions: left.length - shared };
}

function lcsLength(left: string[], right: string[]): number {
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const leftLine = left[row - 1] ?? '';
      const rightLine = right[column - 1] ?? '';
      const above = previous[column] ?? 0;
      const leftValue = current[column - 1] ?? 0;
      const diagonal = previous[column - 1] ?? 0;
      current[column] = leftLine === rightLine ? diagonal + 1 : Math.max(above, leftValue);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[right.length] ?? 0;
}

export function countUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  kind: FileChange['kind'];
  additions: number;
  deletions: number;
  diff: string;
}

export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const text = diff.replace(/\r\n/g, '\n');
  if (!text.trim()) return [];
  const chunks = text.includes('diff --git ')
    ? text.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim())
    : [text];
  return chunks.flatMap((chunk) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const minus = /^--- (?:a\/)?(.+)$/m.exec(chunk);
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk);
    const oldName = header?.[1] ?? (minus?.[1] && minus[1] !== '/dev/null' ? minus[1] : undefined);
    const newName = header?.[2] ?? (plus?.[1] && plus[1] !== '/dev/null' ? plus[1] : undefined);
    const filePath = newName && newName !== '/dev/null' ? newName : oldName;
    if (!filePath || filePath === '/dev/null') return [];
    const removed = plus?.[1] === '/dev/null';
    const added = minus?.[1] === '/dev/null';
    const renamed = Boolean(oldName && newName && oldName !== newName && !added && !removed);
    const counts = countUnifiedDiff(chunk);
    return [{
      path: filePath,
      ...(renamed && oldName ? { oldPath: oldName } : {}),
      kind: removed ? 'delete' : added ? 'add' : renamed ? 'rename' : 'update',
      additions: counts.additions,
      deletions: counts.deletions,
      diff: chunk.trimEnd(),
    }];
  });
}

export function normalizeChangeKind(kind: unknown): { kind: FileChange['kind']; oldPath?: string; movePath?: string } {
  if (typeof kind === 'string') {
    if (kind === 'add' || kind === 'delete' || kind === 'update') return { kind };
    if (kind === 'rename' || kind === 'move') return { kind: 'rename' };
    return { kind: 'update' };
  }
  if (!kind || typeof kind !== 'object') return { kind: 'update' };
  const record = kind as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const move = typeof record.move_path === 'string' ? record.move_path
    : typeof record.movePath === 'string' ? record.movePath : undefined;
  if (type === 'add') return { kind: 'add' };
  if (type === 'delete') return { kind: 'delete' };
  if (type === 'update' && move) return { kind: 'rename', movePath: move };
  if (type === 'rename' || type === 'move') return { kind: 'rename', ...(move ? { oldPath: move } : {}) };
  return { kind: 'update', ...(move ? { oldPath: move } : {}) };
}

/** Full previous text only when the diff is a new file or a pure deletion. Partial hunks are not a baseline. */
export function previousTextFromDiff(diff: string, kind: FileChange['kind']): string | null | undefined {
  if (kind === 'add') return null;
  if (kind !== 'delete') return undefined;
  const lines: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
      || line.startsWith('@@') || line.startsWith('new file') || line.startsWith('deleted file')
      || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('old mode') || line.startsWith('new mode')) continue;
    if (line.startsWith('-')) lines.push(line.slice(1));
    else if (line.startsWith('\\')) continue;
    else return undefined;
  }
  return lines.join('\n');
}

export function extensionBadge(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1, dot + 5).toUpperCase() : base.slice(0, 4).toUpperCase();
  return ext || 'FILE';
}
