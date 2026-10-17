import type { FileChange, FileDiffLine } from './types.js';

const maxLines = 4000;

export function lineChangeCounts(before: string, after: string): { additions: number; deletions: number } | undefined {
  const left = displayLines(before);
  const right = displayLines(after);
  if (left.length > maxLines || right.length > maxLines) return undefined;
  const shared = lcsLength(left, right);
  return { additions: right.length - shared, deletions: left.length - shared };
}

function lcsLength(left: string[], right: string[]): number {
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      // The loop bounds keep every index inside its corresponding array.
      const leftLine = left[row - 1]!;
      const rightLine = right[column - 1]!;
      const above = previous[column]!;
      const leftValue = current[column - 1]!;
      const diagonal = previous[column - 1]!;
      current[column] = leftLine === rightLine ? diagonal + 1 : Math.max(above, leftValue);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[right.length]!;
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

function displayLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

/** A bounded, single-region preview for a file update. Stored contents remain untouched. */
export function previewTextDiff(before: string | null, after: string | null, maxChanged = 10): FileDiffLine[] {
  const oldLines = displayLines(before);
  const newLines = displayLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (!removed.length && !added.length) {
    const oldHasFinalNewline = before?.endsWith('\n') ?? false;
    const newHasFinalNewline = after?.endsWith('\n') ?? false;
    if (oldHasFinalNewline === newHasFinalNewline) return [];
    // Empty and null text both have no final newline, so a mismatch has a displayed tail.
    return [
      { kind: 'context', line: newLines.length, text: newLines.at(-1)! },
      { kind: 'eof', text: newHasFinalNewline ? 'Newline at end of file' : 'No newline at end of file' },
    ];
  }
  const rows: FileDiffLine[] = [];
  if (prefix > 0) rows.push({ kind: 'context', line: prefix, text: oldLines[prefix - 1]! });
  const eachSide = Math.max(1, Math.floor(maxChanged / 2));
  rows.push(...removed.slice(0, eachSide).map((text, index) => ({ kind: 'remove' as const, line: prefix + index + 1, text })));
  if (removed.length > eachSide) rows.push({ kind: 'more', text: `${removed.length - eachSide} removed lines omitted` });
  rows.push(...added.slice(0, eachSide).map((text, index) => ({ kind: 'add' as const, line: prefix + index + 1, text })));
  if (added.length > eachSide) rows.push({ kind: 'more', text: `${added.length - eachSide} added lines omitted` });
  if (suffix > 0) rows.push({ kind: 'context', line: newLines.length - suffix + 1, text: newLines[newLines.length - suffix]! });
  return rows;
}

/** Extracts a small displayable hunk from a unified diff without exposing the full patch. */
export function previewUnifiedDiff(diff: string, maxLines = 14): FileDiffLine[] {
  const rows: FileDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) {
      if (raw.includes('No newline at end of file')) rows.push({ kind: 'eof', text: 'No newline at end of file' });
      continue;
    }
    const prefix = raw[0];
    const content = raw.slice(1).replace(/\r$/, '');
    if (prefix === '-') { rows.push({ kind: 'remove', line: oldLine++, text: content }); continue; }
    if (prefix === '+') { rows.push({ kind: 'add', line: newLine++, text: content }); continue; }
    if (prefix === ' ') {
      rows.push({ kind: 'context', line: newLine++, text: content });
      oldLine += 1;
    }
  }
  const changed = rows.flatMap((row, index) => row.kind === 'context' ? [] : [index]);
  if (!changed.length) return [];
  const start = Math.max(0, changed[0]! - 1);
  const end = Math.min(rows.length, changed.at(-1)! + 2);
  const visible = rows.slice(start, end);
  if (visible.length <= maxLines) return visible;
  const changedVisible = visible.filter((row) => row.kind !== 'context');
  const before = visible.find((row) => row.kind === 'context');
  const after = [...visible].reverse().find((row) => row.kind === 'context');
  const budget = Math.max(2, maxLines - Number(Boolean(before)) - Number(Boolean(after)) - 1);
  const half = Math.ceil(budget / 2);
  const kept = [
    ...(before ? [before] : []),
    ...changedVisible.slice(0, half),
    { kind: 'more' as const, text: `${Math.max(0, changedVisible.length - budget)} changed lines omitted` },
    ...changedVisible.slice(-Math.floor(budget / 2)),
    ...(after ? [after] : []),
  ];
  return kept.slice(0, maxLines);
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
  const text = diff;
  if (!text.trim()) return [];
  const chunks = text.includes('diff --git ')
    ? text.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim())
    : [text];
  return chunks.flatMap((chunk) => {
    const header = /^diff --git a\/(.+?) b\/([^\r\n]+)\r?$/m.exec(chunk);
    const minus = /^--- (?:a\/)?([^\r\n]+)\r?$/m.exec(chunk);
    const plus = /^\+\+\+ (?:b\/)?([^\r\n]+)\r?$/m.exec(chunk);
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
      diff: chunk,
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
  let finalLineHasNewline = true;
  let inHunk = false;
  const emptyFileDeletion = /^deleted file mode /m.test(diff);
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk || !line) continue;
    if (line.startsWith('-')) { lines.push(line.slice(1)); finalLineHasNewline = true; }
    else if (line.startsWith('\\')) {
      if (line.includes('No newline at end of file') && lines.length) finalLineHasNewline = false;
    }
    else return undefined;
  }
  if (!lines.length && !emptyFileDeletion) return undefined;
  return `${lines.join('\n')}${lines.length && finalLineHasNewline ? '\n' : ''}`;
}

export function extensionBadge(fileName: string): string {
  const parts = fileName.split(/[\\/]/);
  const base = parts[parts.length - 1]!;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1, dot + 5).toUpperCase() : base.slice(0, 4).toUpperCase();
  return ext || 'FILE';
}
