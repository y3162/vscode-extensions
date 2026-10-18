import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readTurnRewindJournal, restoreTurnRewindFiles, rollbackTurnRewindJournal, type RewindJournalFile, type TurnRewindJournal } from '../../src/turn-rewind.js';

const fileMode = 0o644;

function entry(file: string, temp: string, beforeText: string | null = 'before', expectedText: string | null = 'after', backupText: string | null = 'after'): RewindJournalFile {
  return {
    path: file, beforeText, beforeMode: beforeText === null ? null : fileMode,
    expectedText, expectedMode: expectedText === null ? null : fileMode,
    backupText, backupMode: backupText === null ? null : fileMode, tempPath: temp,
  };
}

function journal(cwd: string, files: RewindJournalFile[]): TurnRewindJournal {
  return { version: 1, conversationId: 'conversation', branchId: 'branch', cwd, files };
}

test('journal validation rejects duplicate and colliding paths and accepts exactly four million bytes', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-journal-')));
  const journalFile = path.join(cwd, 'journal.json');
  const sentinel = path.join(cwd, 'sentinel.txt');
  await writeFile(sentinel, 'must remain unchanged');
  const id1 = '.ai-agents-rewind-00000000-0000-4000-8000-000000000001.tmp';
  const id2 = '.ai-agents-rewind-00000000-0000-4000-8000-000000000002.tmp';
  const id3 = '.ai-agents-rewind-00000000-0000-4000-8000-000000000003.tmp';

  try {
    const valid = journal(cwd, [entry('a.txt', id1), entry('b.txt', id2)]);
    const malformed: TurnRewindJournal[] = [
      journal(cwd, [entry('a.txt', id1), entry('a.txt', id2)]),
      journal(cwd, [entry('a.txt', id1), entry('b.txt', id1)]),
      journal(cwd, [entry('a.txt', id1), entry(id1, id2)]),
      journal(cwd, [entry('nested/a.txt', id1)]),
      journal(cwd, [entry('../outside.txt', id1)]),
      journal(cwd, [entry('/tmp/outside.txt', id1)]),
    ];
    for (const value of malformed) {
      await writeFile(journalFile, JSON.stringify(value));
      await assert.rejects(readTurnRewindJournal(journalFile), /Invalid turn rewind journal/);
      assert.equal(await readFile(sentinel, 'utf8'), 'must remain unchanged');
    }

    const halfMeg = 'x'.repeat(500_000);
    const exactBoundary = journal(cwd, [
      entry('one.txt', id1, halfMeg, halfMeg, halfMeg),
      entry('two.txt', id2, halfMeg, halfMeg, halfMeg),
      entry('three.txt', id3, halfMeg, halfMeg, ''),
    ]);
    await writeFile(journalFile, JSON.stringify(exactBoundary));
    const restored = await readTurnRewindJournal(journalFile);
    assert.equal(restored.files.length, 3);
    assert.equal(restored.files.reduce((sum, item) => sum + Buffer.byteLength(item.beforeText ?? '') + Buffer.byteLength(item.expectedText ?? '') + Buffer.byteLength(item.backupText ?? ''), 0), 4_000_000);

    const overBoundary = journal(cwd, [
      entry('one.txt', id1, halfMeg, halfMeg, halfMeg),
      entry('two.txt', id2, halfMeg, halfMeg, halfMeg),
      entry('three.txt', id3, halfMeg, halfMeg, 'x'),
    ]);
    await writeFile(journalFile, JSON.stringify(overBoundary));
    await assert.rejects(readTurnRewindJournal(journalFile), /Invalid turn rewind journal/);
    assert.equal(await readFile(sentinel, 'utf8'), 'must remain unchanged');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rewind and rollback reject a workspace journaled through a symlink alias', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-identity-')));
  const alias = path.join(path.dirname(cwd), `${path.basename(cwd)}-alias`);
  const sentinel = path.join(cwd, 'sentinel.txt');
  await writeFile(sentinel, 'unchanged');
  await symlink(cwd, alias, 'dir');

  try {
    const aliased = journal(alias, []);
    await assert.rejects(restoreTurnRewindFiles(aliased), /workspace location changed/);
    await assert.rejects(rollbackTurnRewindJournal(aliased), /workspace location changed/);
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
  } finally {
    await rm(alias, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rollback refuses a symlink temporary path and can retry without touching its target', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-rollback-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-target-')));
  const outsideFile = path.join(outside, 'sentinel.txt');
  const workspaceFile = path.join(cwd, 'a.txt');
  const tempName = '.ai-agents-rewind-00000000-0000-4000-8000-000000000004.tmp';
  const tempPath = path.join(cwd, tempName);
  await writeFile(outsideFile, 'outside unchanged');
  await writeFile(workspaceFile, 'after');
  await chmod(workspaceFile, fileMode);
  await symlink(outsideFile, tempPath);
  const crafted = journal(cwd, [entry('a.txt', tempName, 'before', 'after', 'before')]);

  try {
    await assert.rejects(rollbackTurnRewindJournal(crafted), /Unsafe rewind temporary file/);
    assert.equal(await readFile(workspaceFile, 'utf8'), 'after');
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside unchanged');

    await rm(tempPath);
    await rollbackTurnRewindJournal(crafted);
    assert.equal(await readFile(workspaceFile, 'utf8'), 'before');
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside unchanged');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('rollback reports a temporary path that became a directory and preserves the target file', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-temp-dir-')));
  const workspaceFile = path.join(cwd, 'a.txt');
  const tempName = '.ai-agents-rewind-00000000-0000-4000-8000-000000000009.tmp';
  const tempPath = path.join(cwd, tempName);
  await writeFile(workspaceFile, 'after');
  await mkdir(tempPath);
  const crafted = journal(cwd, [entry('a.txt', tempName, 'before', 'after', 'after')]);

  try {
    await assert.rejects(rollbackTurnRewindJournal(crafted), /Unsafe rewind temporary file/);
    assert.equal(await readFile(workspaceFile, 'utf8'), 'after', 'cleanup failure does not rewrite the workspace target');
    assert.deepEqual(await readdir(tempPath), [], 'the unexpected directory is not recursively deleted');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rollback records a workspace symlink conflict without following or changing its target', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-target-link-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-target-outside-')));
  const outsideFile = path.join(outside, 'sentinel.txt');
  const workspaceLink = path.join(cwd, 'a.txt');
  await writeFile(outsideFile, 'private');
  await symlink(outsideFile, workspaceLink);
  const crafted = journal(cwd, [entry('a.txt', '.ai-agents-rewind-00000000-0000-4000-8000-000000000010.tmp')]);

  try {
    await assert.rejects(rollbackTurnRewindJournal(crafted), /not a small regular file/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'private');
    assert.equal((await lstat(workspaceLink)).isSymbolicLink(), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a later missing parent rolls back files already restored earlier in the journal', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-partial-')));
  const firstFile = path.join(cwd, 'a.txt');
  await writeFile(firstFile, 'after');
  await chmod(firstFile, fileMode);
  const crafted = journal(cwd, [
    entry('a.txt', '.ai-agents-rewind-00000000-0000-4000-8000-000000000005.tmp', 'before', 'after', 'after'),
    entry('missing/b.txt', 'missing/.ai-agents-rewind-00000000-0000-4000-8000-000000000006.tmp', 'before', 'after', 'after'),
  ]);

  try {
    await assert.rejects(restoreTurnRewindFiles(crafted), /checkpoint parent directory is missing/);
    assert.equal(await readFile(firstFile, 'utf8'), 'after', 'the first file is restored to its pre-rewind backup');
    assert.deepEqual(await readdir(cwd), ['a.txt'], 'the failed restoration leaves no temporary files');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an unreadable partially restored file reports incomplete rollback instead of hiding the failure', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-rollback-mode-')));
  const firstFile = path.join(cwd, 'a.txt');
  await writeFile(firstFile, 'after', { mode: fileMode });
  const unreadable = {
    ...entry('a.txt', '.ai-agents-rewind-00000000-0000-4000-8000-000000000007.tmp', 'before', 'after', 'after'),
    beforeMode: 0,
  };
  const crafted = journal(cwd, [
    unreadable,
    entry('missing/b.txt', 'missing/.ai-agents-rewind-00000000-0000-4000-8000-000000000008.tmp', 'before', 'after', 'after'),
  ]);

  try {
    await assert.rejects(restoreTurnRewindFiles(crafted), /file rollback was incomplete.*EACCES|permission/i);
    await chmod(firstFile, fileMode);
    assert.equal(await readFile(firstFile, 'utf8'), 'before', 'the incomplete rollback is observable and the caller can recover the partial file');
  } finally {
    await chmod(firstFile, fileMode).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});
