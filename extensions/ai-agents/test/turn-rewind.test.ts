import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTurnRewindPlan, prepareTurnRewindJournal, restoreTurnRewindFiles } from '../src/turn-rewind.js';
import { emptyPlanState, type TurnFileSnapshot, type TurnRecord } from '../src/types.js';

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
