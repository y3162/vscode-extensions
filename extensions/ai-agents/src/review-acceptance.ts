import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isInsideWorkspace, isRealPathInsideWorkspace } from './change-review.js';
import { errorMessage, type FileChange, type ReviewAcceptance } from './types.js';

const maxSnapshot = 500_000;
const syntheticNames = new Set(['turn.diff', 'patch']);

export function contentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function reviewableChanges(changes: FileChange[]): FileChange[] {
  return changes.filter((change) => !syntheticNames.has(change.path) && !syntheticNames.has(path.basename(change.path)));
}

export function changeSetFingerprint(changes: FileChange[]): string {
  const rows = reviewableChanges(changes).map((change) => [
    change.path,
    change.kind,
    change.oldPath ?? '',
    change.previousText === undefined ? '' : change.previousText === null ? 'null' : contentDigest(change.previousText),
    change.diff ?? '',
  ].join('\0')).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export interface UndoBlock {
  path: string;
  reason: string;
}

export interface UndoPlan {
  ok: boolean;
  targets: FileChange[];
  blocks: UndoBlock[];
}

export interface ReviewProjection {
  status: 'pending' | 'accepted' | 'conflict';
  undoEnabled: boolean;
  keepEnabled: boolean;
  undoReason?: string;
}

export interface ReviewProbe {
  fingerprint: string;
  digests: Record<string, string | null>;
  undoEnabled: boolean;
  undoReason?: string;
}

function workspacePath(change: FileChange, roots: string[]): string | undefined {
  const candidates = path.isAbsolute(change.path) ? [path.resolve(change.path)] : roots.map((root) => path.resolve(root, change.path));
  return candidates.find((candidate) => isInsideWorkspace(candidate, roots));
}

export async function readChangeDigest(change: FileChange, roots: string[]): Promise<string | null | undefined> {
  const resolved = workspacePath(change, roots);
  if (!resolved || !await isRealPathInsideWorkspace(resolved, roots)) return undefined;
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxSnapshot) return undefined;
    const bytes = await readFile(resolved);
    if (bytes.length > maxSnapshot || bytes.includes(0)) return undefined;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
    return contentDigest(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
}

export async function inspectUndoAll(changes: FileChange[], roots: string[], dirtyPaths: ReadonlySet<string>): Promise<UndoPlan> {
  const targets = reviewableChanges(changes);
  if (!targets.length) return { ok: false, targets: [], blocks: [{ path: '', reason: '一括で戻す対象ファイルがありません。' }] };
  if (targets.some((change) => change.kind === 'rename' || change.oldPath)) {
    return { ok: false, targets: [], blocks: targets.filter((change) => change.kind === 'rename' || change.oldPath).map((change) => ({ path: change.path, reason: '移動を含む変更は一括Undoできません。' })) };
  }
  const blocks: UndoBlock[] = [];
  for (const change of targets) {
    const resolved = workspacePath(change, roots);
    if (!resolved) {
      blocks.push({ path: change.path, reason: 'ワークスペース外のファイルは戻せません。' });
      continue;
    }
    if (dirtyPaths.has(resolved) || dirtyPaths.has(change.path)) {
      blocks.push({ path: change.path, reason: '未保存のエディタ変更があるため戻せません。' });
      continue;
    }
    if (change.previousText === undefined || change.observedDigest === undefined) {
      blocks.push({ path: change.path, reason: '変更前または変更直後の内容が保存されていないため戻せません。' });
      continue;
    }
    if (!await isRealPathInsideWorkspace(resolved, roots)) {
      blocks.push({ path: change.path, reason: 'ワークスペース外への参照は戻せません。' });
      continue;
    }
    try {
      const info = await lstat(resolved);
      if (info.isSymbolicLink() || !info.isFile()) {
        blocks.push({ path: change.path, reason: '通常ファイル以外は戻せません。' });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        blocks.push({ path: change.path, reason: 'ファイルの種類を確認できません。' });
        continue;
      }
    }
    const current = await readChangeDigest(change, roots);
    if (current === undefined || current !== change.observedDigest) {
      blocks.push({ path: change.path, reason: '変更直後の内容と現在のファイルが一致しないため戻せません。' });
    }
  }
  if (blocks.length) return { ok: false, targets: [], blocks };
  return { ok: true, targets, blocks: [] };
}

export async function captureAcceptance(changes: FileChange[], roots: string[]): Promise<{ ok: true; acceptance: ReviewAcceptance } | { ok: false; reason: string }> {
  const targets = reviewableChanges(changes);
  if (!targets.length) return { ok: false, reason: '受け入れる変更ファイルがありません。' };
  const digests: Record<string, string | null> = {};
  for (const change of targets) {
    const digest = await readChangeDigest(change, roots);
    if (digest === undefined) return { ok: false, reason: `${path.basename(change.path)} の現在の内容を確認できないため、受け入れできません。` };
    digests[change.path] = digest;
  }
  return { ok: true, acceptance: { fingerprint: changeSetFingerprint(changes), digests } };
}

export function projectReview(
  changes: FileChange[],
  acceptance: ReviewAcceptance | undefined,
  probe: ReviewProbe | undefined,
  reasons: { checking: string; conflict: string; unavailable: string },
): ReviewProjection {
  const fingerprint = changeSetFingerprint(changes);
  const liveKnown = probe?.fingerprint === fingerprint;
  const sameSet = acceptance?.fingerprint === fingerprint;
  let drifted = false;
  if (sameSet && liveKnown) {
    drifted = reviewableChanges(changes).some((change) => probe!.digests[change.path] !== acceptance!.digests[change.path]);
  }
  const status: ReviewProjection['status'] = sameSet ? (drifted ? 'conflict' : 'accepted') : 'pending';
  if (status === 'accepted') return { status, undoEnabled: false, keepEnabled: false };
  if (status === 'conflict') return { status, undoEnabled: false, keepEnabled: true, undoReason: reasons.conflict };
  if (!liveKnown) return { status, undoEnabled: false, keepEnabled: true, undoReason: reasons.checking };
  if (!probe?.undoEnabled) return { status, undoEnabled: false, keepEnabled: true, undoReason: probe?.undoReason || reasons.unavailable };
  return { status, undoEnabled: true, keepEnabled: true };
}

export async function applyUndoAll(
  targets: FileChange[],
  roots: string[],
  revert: (change: FileChange, roots: string[]) => Promise<void>,
): Promise<{ restored: string[]; failed?: { path: string; message: string } }> {
  const restored: string[] = [];
  for (const change of targets) {
    try {
      await revert(change, roots);
      restored.push(change.path);
    } catch (error) {
      return { restored, failed: { path: change.path, message: errorMessage(error) } };
    }
  }
  return { restored };
}

export function undoReasonText(blocks: UndoBlock[]): string {
  const lines = blocks.filter((block) => block.reason).map((block) => block.path ? `${path.basename(block.path)}: ${block.reason}` : block.reason);
  return lines.join('\n').slice(0, 700);
}
