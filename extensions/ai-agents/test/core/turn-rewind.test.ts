import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTurnRewindPlan, discardTurnRewindJournal, prepareTurnRewindJournal, readTurnRewindJournal, restoreTurnRewindFiles, rollbackTurnRewindJournal } from '../../src/turn-rewind.js';
import { emptyPlanState, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

async function workspace(): Promise<string> { return realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-turn-rewind-'))); }

function turn(id: string, root: string, files: TurnFileSnapshot[]): TurnRecord {
  return {
    id, backendTurnId: `backend-${id}`, startedAt: 1, endedAt: 2, status: 'completed', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat', planBefore: emptyPlanState(), todosBefore: [],
    fileCheckpoint: { status: 'captured', workspaceRoot: root, files },
  };
}

test('a middle-turn rewind restores the earliest before-state across later edits and additions', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'xyz', { mode });
    await writeFile(path.join(cwd, 'b.txt'), 'later', { mode });
    const turns = [
      { id: 't1', status: 'completed', startedAt: 0, endedAt: 1, waitMs: 0, mode: 'agent', model: '', intent: 'chat' } as TurnRecord,
      turn('t2', cwd, [{ path: 'a.txt', beforeText: '', afterText: 'abcd', beforeMode: mode, afterMode: mode }]),
      turn('t3', cwd, [
        { path: 'a.txt', beforeText: 'abcd', afterText: 'xyz', beforeMode: mode, afterMode: mode },
        { path: 'b.txt', beforeText: null, afterText: 'later', beforeMode: null, afterMode: mode },
      ]),
    ];
    const plan = await buildTurnRewindPlan(turns, 't2', cwd);
    assert.equal(plan.removedTurns, 2);
    assert.deepEqual(plan.files.map((file) => [file.path, file.beforeText, file.expectedText]), [
      ['a.txt', '', 'xyz'], ['b.txt', null, 'later'],
    ]);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), '');
    await assert.rejects(readFile(path.join(cwd, 'b.txt'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('checkpoint conflicts and missing checkpoints fail closed', async () => {
  const cwd = await workspace();
  try {
    await writeFile(path.join(cwd, 'a.txt'), 'manual edit');
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([saved], 't1', cwd), /changed after its checkpoint/);
    await writeFile(path.join(cwd, 'a.txt'), 'after');
    await chmod(path.join(cwd, 'a.txt'), 0o644);
    const missing = { ...saved, fileCheckpoint: { status: 'unsupported' as const, files: [], reason: 'binary' } };
    await assert.rejects(buildTurnRewindPlan([missing], 't1', cwd), /binary/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('rewind restores trailing LF, CRLF, no-final-LF, empty files and executable modes exactly', async () => {
  const cwd = await workspace();
  try {
    const before = [
      ['lf.txt', 'line\n', 'changed\n'],
      ['crlf.txt', 'one\r\ntwo\r\n', 'changed\n'],
      ['no-final-lf.txt', 'no newline', 'changed\n'],
      ['empty.txt', '', 'changed\n'],
    ] as const;
    for (const [name, , after] of before) await writeFile(path.join(cwd, name), after, { mode: 0o755 });
    const files: TurnFileSnapshot[] = before.map(([name, beforeText, afterText]) => ({
      path: name, beforeText, afterText, beforeMode: 0o644, afterMode: 0o755,
    }));
    const saved = turn('t1', cwd, files);
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    for (const [name, text] of before) {
      assert.deepEqual(await readFile(path.join(cwd, name)), Buffer.from(text));
      assert.equal((await stat(path.join(cwd, name))).mode & 0o777, 0o644);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a conflict during a multi-file restore rolls back files already restored', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'new-a', { mode });
    await writeFile(path.join(cwd, 'b.txt'), 'new-b', { mode });
    const saved = turn('t1', cwd, [
      { path: 'a.txt', beforeText: 'old-a', afterText: 'new-a', beforeMode: mode, afterMode: mode },
      { path: 'b.txt', beforeText: 'old-b', afterText: 'new-b', beforeMode: mode, afterMode: mode },
    ]);
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await writeFile(path.join(cwd, 'b.txt'), 'external edit');
    await assert.rejects(restoreTurnRewindFiles(journal.journal), /changed during rewind/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new-a');
    assert.equal(await readFile(path.join(cwd, 'b.txt'), 'utf8'), 'external edit');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('rewinding the first of several turns removes every later file change', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'three', { mode });
    const turns = [
      turn('t1', cwd, [{ path: 'a.txt', beforeText: null, afterText: 'one', beforeMode: null, afterMode: mode }]),
      turn('t2', cwd, [{ path: 'a.txt', beforeText: 'one', afterText: 'two', beforeMode: mode, afterMode: mode }]),
      turn('t3', cwd, [{ path: 'a.txt', beforeText: 'two', afterText: 'three', beforeMode: mode, afterMode: mode }]),
    ];
    const plan = await buildTurnRewindPlan(turns, 't1', cwd);
    assert.equal(plan.removedTurns, 3);
    assert.equal(plan.files[0]?.beforeText, null);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    await assert.rejects(readFile(path.join(cwd, 'a.txt'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('rewinding only the last turn restores that turn and leaves earlier text', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'three', { mode });
    const turns = [
      turn('t1', cwd, [{ path: 'a.txt', beforeText: null, afterText: 'one', beforeMode: null, afterMode: mode }]),
      turn('t2', cwd, [{ path: 'a.txt', beforeText: 'one', afterText: 'two', beforeMode: mode, afterMode: mode }]),
      turn('t3', cwd, [{ path: 'a.txt', beforeText: 'two', afterText: 'three', beforeMode: mode, afterMode: mode }]),
    ];
    const plan = await buildTurnRewindPlan(turns, 't3', cwd);
    assert.equal(plan.removedTurns, 1);
    assert.equal(plan.files[0]?.beforeText, 'two');
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'two');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('checkpoints that do not join are rejected before any file is changed', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'later');
    const turns = [
      turn('t1', cwd, [{ path: 'a.txt', beforeText: 'old', afterText: 'middle', beforeMode: mode, afterMode: mode }]),
      turn('t2', cwd, [{ path: 'a.txt', beforeText: 'different', afterText: 'later', beforeMode: mode, afterMode: mode }]),
    ];
    await assert.rejects(buildTurnRewindPlan(turns, 't1', cwd), /do not join cleanly/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'later');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an affected checkpoint larger than the safe limit is rejected', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    const chunk = 'x'.repeat(200_001);
    const files = Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.txt`, beforeText: chunk, afterText: chunk, beforeMode: mode, afterMode: mode }));
    await assert.rejects(buildTurnRewindPlan([turn('t1', cwd, files)], 't1', cwd), /safe size limit/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a deleted file is recreated from its before-state', async () => {
  const cwd = await workspace();
  try {
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'old\n', afterText: null, beforeMode: 0o644, afterMode: null }]);
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old\n');
    assert.equal((await stat(path.join(cwd, 'a.txt'))).mode & 0o777, 0o644);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('binary files and symlinks are not restored', async () => {
  const cwd = await workspace();
  try {
    await writeFile(path.join(cwd, 'binary.txt'), Buffer.from([0x61, 0, 0x62]));
    const binary = turn('t1', cwd, [{ path: 'binary.txt', beforeText: 'a', afterText: 'ab', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([binary], 't1', cwd), /binary/);
    await symlink('binary.txt', path.join(cwd, 'link.txt'));
    const linked = turn('t2', cwd, [{ path: 'link.txt', beforeText: 'a', afterText: 'b', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([linked], 't2', cwd), /not a small regular file/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a file edited after the plan was built fails before rewind begins', async () => {
  const cwd = await workspace();
  try {
    await writeFile(path.join(cwd, 'a.txt'), 'after');
    await chmod(path.join(cwd, 'a.txt'), 0o644);
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: 0o644, afterMode: 0o644 }]);
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    await writeFile(path.join(cwd, 'a.txt'), 'manual');
    await assert.rejects(prepareTurnRewindJournal(path.join(cwd, 'journals'), 'chat', 'branch', cwd, plan), /changed before rewind began/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'manual');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('incomplete turns, a moved workspace, and repeated retry ids are rejected', async () => {
  const cwd = await workspace();
  try {
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'a', afterText: 'b', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([{ ...saved, status: 'failed' }], 't1', cwd), /completed successfully/);
    await assert.rejects(buildTurnRewindPlan([{ ...saved, fileCheckpoint: { ...saved.fileCheckpoint!, workspaceRoot: '/elsewhere' } }], 't1', cwd), /workspace location changed/);
    await assert.rejects(buildTurnRewindPlan([{ ...saved, userMessageId: 'original-user' }], 't1', cwd), /Retry attempts cannot be used/);
    await assert.rejects(buildTurnRewindPlan([saved, { ...saved }], 't1', cwd), /Repeated retry/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a single snapshot above the per-file cap is rejected before the turn-size check', async () => {
  const cwd = await workspace();
  try {
    const huge = 'x'.repeat(500_001);
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: huge, afterText: 'after', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([saved], 't1', cwd), /Unsupported file snapshot/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a checkpoint path through a symlink parent is rejected', async () => {
  const cwd = await workspace();
  try {
    const real = path.join(cwd, 'real');
    await writeFile(real, 'after');
    await symlink(cwd, path.join(cwd, 'link'));
    const saved = turn('t1', cwd, [{ path: 'link/real', beforeText: 'before', afterText: 'after', beforeMode: 0o644, afterMode: 0o644 }]);
    await assert.rejects(buildTurnRewindPlan([saved], 't1', cwd), /symlink|not safely restorable/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an invalid journal version is rejected', async () => {
  const cwd = await workspace();
  try {
    const file = path.join(cwd, 'journal.json');
    await writeFile(file, JSON.stringify({ version: 2, conversationId: 'c', branchId: 'b', cwd, files: [] }));
    await assert.rejects(readTurnRewindJournal(file), /Invalid turn rewind journal/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('host recovery discards a journal when the saved session is already the branch', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'before', { mode });
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: mode, afterMode: mode }]);
    await writeFile(path.join(cwd, 'a.txt'), 'after', { mode });
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'conversation-1', 'branch-1', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    const savedSessionId: string | undefined = 'branch-1';
    if (savedSessionId === journal.journal.branchId) await discardTurnRewindJournal(journal.path);
    else { await rollbackTurnRewindJournal(journal.journal); await discardTurnRewindJournal(journal.path); }
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'before');
    await assert.rejects(readFile(journal.path, 'utf8'), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('host recovery rolls files back when the saved session is not the branch', async () => {
  const cwd = await workspace();
  try {
    const mode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'before', { mode });
    const saved = turn('t1', cwd, [{ path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: mode, afterMode: mode }]);
    await writeFile(path.join(cwd, 'a.txt'), 'after', { mode });
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const journal = await prepareTurnRewindJournal(path.join(cwd, 'journals'), 'conversation-1', 'branch-1', cwd, plan);
    await restoreTurnRewindFiles(journal.journal);
    const savedSessionId: string | undefined = 'thread-1';
    if (savedSessionId === journal.journal.branchId) await discardTurnRewindJournal(journal.path);
    else { await rollbackTurnRewindJournal(journal.journal); await discardTurnRewindJournal(journal.path); }
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    await assert.rejects(readFile(journal.path, 'utf8'), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
