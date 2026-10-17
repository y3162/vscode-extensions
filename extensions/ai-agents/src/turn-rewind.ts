import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TurnFileSnapshot, TurnRecord } from './types.js';

const maxFileBytes = 500_000;
const maxTurnBytes = 2_000_000;

export interface RewindFile {
  path: string;
  beforeText: string | null;
  beforeMode: number | null;
  expectedText: string | null;
  expectedMode: number | null;
}

export interface TurnRewindPlan {
  targetId: string;
  targetIndex: number;
  removedTurns: number;
  files: RewindFile[];
}

export interface RewindJournalFile extends RewindFile {
  backupText: string | null;
  backupMode: number | null;
  tempPath: string;
}

export interface TurnRewindJournal {
  version: 1;
  conversationId: string;
  branchId: string;
  cwd: string;
  files: RewindJournalFile[];
}

export interface FileValue { text: string | null; mode: number | null }

function equalValue(left: FileValue, right: FileValue): boolean {
  return left.text === right.text && left.mode === right.mode;
}

export function workspaceRelativePath(cwd: string, rawPath: string): string {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Workspace path is not safely restorable: ${rawPath}`);
  return relative;
}

async function checkedFilePath(root: string, relative: string): Promise<string> {
  const safeRelative = workspaceRelativePath(root, relative);
  let cursor = root;
  const parts = safeRelative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`A checkpoint path crosses a non-directory or symlink: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`A checkpoint parent directory is missing: ${relative}`);
      throw error;
    }
  }
  return path.join(root, safeRelative);
}

export async function readSafeWorkspaceFile(cwd: string, relative: string): Promise<FileValue> {
  const root = await realpath(cwd);
  const candidate = await checkedFilePath(root, relative);
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) throw new Error(`A checkpoint file is not a small regular file: ${relative}`);
    const bytes = await readFile(candidate);
    if (bytes.length > maxFileBytes) throw new Error(`A checkpoint file is not a small regular file: ${relative}`);
    if (bytes.includes(0)) throw new Error(`A checkpoint file is binary: ${relative}`);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`A checkpoint file is not valid UTF-8: ${relative}`);
    return { text, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode: null };
    throw error;
  }
}

function checkpointError(turn: TurnRecord): string | undefined {
  if (turn.status !== 'completed') return 'Every affected turn must have completed successfully.';
  if (turn.userMessageId && turn.userMessageId !== turn.id) return 'Retry attempts cannot be used as rewind boundaries.';
  if (turn.fileCheckpoint?.status !== 'captured') return turn.fileCheckpoint?.reason || 'A complete file checkpoint is unavailable.';
  return undefined;
}

function validSnapshot(snapshot: TurnFileSnapshot): void {
  if (snapshot.path !== path.normalize(snapshot.path) || path.isAbsolute(snapshot.path) || snapshot.path === '.' || snapshot.path.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe checkpoint path: ${snapshot.path}`);
  }
  if (snapshot.beforeText !== null && (Buffer.byteLength(snapshot.beforeText) > maxFileBytes || snapshot.beforeText.includes('\0'))) throw new Error(`Unsupported file snapshot: ${snapshot.path}`);
  if (snapshot.afterText !== null && (Buffer.byteLength(snapshot.afterText) > maxFileBytes || snapshot.afterText.includes('\0'))) throw new Error(`Unsupported file snapshot: ${snapshot.path}`);
  for (const mode of [snapshot.beforeMode, snapshot.afterMode]) if (mode !== null && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) throw new Error(`Unsupported file mode: ${snapshot.path}`);
}

export async function buildTurnRewindPlan(turns: TurnRecord[], targetId: string, cwd: string): Promise<TurnRewindPlan> {
  const targetIndex = turns.findIndex((turn) => turn.id === targetId);
  if (targetIndex < 0) throw new Error('The selected user turn is no longer in this conversation.');
  const affected = turns.slice(targetIndex);
  const root = await realpath(cwd);
  const userIds = new Set<string>();
  for (const turn of affected) {
    const error = checkpointError(turn);
    if (error) throw new Error(error);
    if (turn.fileCheckpoint?.workspaceRoot !== root) throw new Error('The workspace location changed since this checkpoint was recorded.');
    const userId = turn.userMessageId ?? turn.id;
    if (userIds.has(userId)) throw new Error('Repeated retry attempts make this turn boundary ambiguous.');
    userIds.add(userId);
  }

  const files = new Map<string, RewindFile>();
  let bytes = 0;
  for (const turn of affected) {
    for (const snapshot of turn.fileCheckpoint!.files) {
      validSnapshot(snapshot);
      const relative = workspaceRelativePath(cwd, snapshot.path);
      const existing = files.get(relative);
      if (!existing) {
        files.set(relative, {
          path: relative,
          beforeText: snapshot.beforeText,
          beforeMode: snapshot.beforeMode,
          expectedText: snapshot.afterText,
          expectedMode: snapshot.afterMode,
        });
      } else {
        if (existing.expectedText !== snapshot.beforeText || existing.expectedMode !== snapshot.beforeMode) throw new Error(`Turn checkpoints do not join cleanly for ${relative}.`);
        existing.expectedText = snapshot.afterText;
        existing.expectedMode = snapshot.afterMode;
      }
      bytes += Buffer.byteLength(snapshot.beforeText ?? '') + Buffer.byteLength(snapshot.afterText ?? '');
      if (bytes > maxTurnBytes) throw new Error('The affected file checkpoints exceed the safe size limit.');
    }
  }

  for (const file of files.values()) {
    const current = await readSafeWorkspaceFile(root, file.path);
    if (!equalValue(current, { text: file.expectedText, mode: file.expectedMode })) throw new Error(`The file changed after its checkpoint: ${file.path}`);
  }
  return { targetId, targetIndex, removedTurns: affected.length, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

async function writeJournalFile(directory: string, journal: TurnRewindJournal): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${randomUUID()}.json`);
  const temporary = `${target}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, target);
  return target;
}

async function setFile(cwd: string, file: Pick<RewindJournalFile, 'path' | 'tempPath'>, value: FileValue): Promise<void> {
  const root = await realpath(cwd);
  const candidate = await checkedFilePath(root, file.path);
  if (value.text === null) {
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    return;
  }
  if (value.mode === null) throw new Error(`A restored file has no recorded mode: ${file.path}`);
  const temporary = path.resolve(root, file.tempPath);
  if (path.dirname(temporary) !== path.dirname(candidate)) throw new Error(`Invalid transaction temporary path: ${file.path}`);
  await writeFile(temporary, value.text, { encoding: 'utf8', mode: value.mode, flag: 'wx' });
  await chmod(temporary, value.mode);
  await rename(temporary, candidate);
}

async function cleanupTemporary(cwd: string, file: RewindJournalFile): Promise<void> {
  try {
    const root = await realpath(cwd);
    const temporary = await checkedFilePath(root, file.tempPath);
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe rewind temporary file: ${file.tempPath}`);
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function prepareTurnRewindJournal(
  directory: string,
  conversationId: string,
  branchId: string,
  cwd: string,
  plan: TurnRewindPlan,
): Promise<{ path: string; journal: TurnRewindJournal }> {
  const root = await realpath(cwd);
  const files: RewindJournalFile[] = [];
  for (const file of plan.files) {
    const backup = await readSafeWorkspaceFile(root, file.path);
    if (!equalValue(backup, { text: file.expectedText, mode: file.expectedMode })) throw new Error(`The file changed before rewind began: ${file.path}`);
    const parent = path.dirname(file.path);
    files.push({ ...file, backupText: backup.text, backupMode: backup.mode, tempPath: path.join(parent, `.ai-agents-rewind-${randomUUID()}.tmp`) });
  }
  const journal: TurnRewindJournal = { version: 1, conversationId, branchId, cwd: root, files };
  const journalPath = await writeJournalFile(directory, journal);
  return { path: journalPath, journal };
}

export async function restoreTurnRewindFiles(journal: TurnRewindJournal): Promise<void> {
  const applied: RewindJournalFile[] = [];
  try {
    for (const file of journal.files) {
      const current = await readSafeWorkspaceFile(journal.cwd, file.path);
      const backup = { text: file.backupText, mode: file.backupMode };
      const expected = { text: file.expectedText, mode: file.expectedMode };
      if (!equalValue(current, backup) && !equalValue(current, expected)) throw new Error(`The file changed during rewind: ${file.path}`);
      if (!equalValue(current, { text: file.beforeText, mode: file.beforeMode })) await setFile(journal.cwd, file, { text: file.beforeText, mode: file.beforeMode });
      applied.push(file);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const file of applied.reverse()) {
      try {
        const current = await readSafeWorkspaceFile(journal.cwd, file.path);
        const target = { text: file.beforeText, mode: file.beforeMode };
        const backup = { text: file.backupText, mode: file.backupMode };
        if (equalValue(current, target)) await setFile(journal.cwd, file, backup);
        else if (!equalValue(current, backup)) throw new Error(`The file changed during rollback: ${file.path}`);
      } catch (restoreError) { failures.push(restoreError instanceof Error ? restoreError.message : String(restoreError)); }
    }
    if (failures.length) throw new Error(`Rewind failed and file rollback was incomplete: ${failures.join('; ')}`, { cause: error });
    throw error;
  } finally {
    for (const file of journal.files) await cleanupTemporary(journal.cwd, file).catch(() => {});
  }
}

export async function rollbackTurnRewindJournal(journal: TurnRewindJournal): Promise<void> {
  const failures: string[] = [];
  for (const file of [...journal.files].reverse()) {
    try {
      const current = await readSafeWorkspaceFile(journal.cwd, file.path);
      const backup = { text: file.backupText, mode: file.backupMode };
      const expected = { text: file.expectedText, mode: file.expectedMode };
      const target = { text: file.beforeText, mode: file.beforeMode };
      if (equalValue(current, backup)) continue;
      if (!equalValue(current, expected) && !equalValue(current, target)) throw new Error(`The file changed after the interrupted rewind: ${file.path}`);
      await setFile(journal.cwd, file, backup);
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    await cleanupTemporary(journal.cwd, file).catch((error) => failures.push(error instanceof Error ? error.message : String(error)));
  }
  if (failures.length) throw new Error(failures.join('; '));
}

export async function readTurnRewindJournal(file: string): Promise<TurnRewindJournal> {
  const value = JSON.parse(await readFile(file, 'utf8')) as TurnRewindJournal;
  if (value.version !== 1 || typeof value.conversationId !== 'string' || typeof value.branchId !== 'string' || typeof value.cwd !== 'string' || !Array.isArray(value.files)) throw new Error('Invalid turn rewind journal.');
  return value;
}

export async function discardTurnRewindJournal(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
