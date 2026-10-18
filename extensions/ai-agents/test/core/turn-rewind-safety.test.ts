import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from '../../src/capabilities.js';

import { HistoryStore, type SavedConversation } from '../../src/history-store.js';

import { buildTurnRewindPlan, discardTurnRewindJournal, prepareTurnRewindJournal, readSafeWorkspaceFile, readTurnRewindJournal, restoreTurnRewindFiles, rollbackTurnRewindJournal, workspaceRelativePath } from '../../src/turn-rewind.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

function saved(id: string, state = chatState()): SavedConversation {
  return { version: 1, id, sessionId: `session-${id}`, updatedAt: '2026-10-17T00:00:00.000Z', controls: defaultControls('codex', 'sdk'), state };
}

function capturedTurn(id: string, root: string, files: TurnFileSnapshot[], extra: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id, backendTurnId: `backend-${id}`, startedAt: 1, endedAt: 2, status: 'completed', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat', planBefore: emptyPlanState(), todosBefore: [],
    fileCheckpoint: { status: 'captured', workspaceRoot: root, files }, ...extra,
  };
}

function chatState(cwd = '/work', messages: ChatState['messages'] = [{ id: 'm1', role: 'user', text: 'hello' }]): ChatState {
  return {
    selection: selection(cwd), busy: false, messages, queue: [], status: 'idle', usage: null,
    changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
  };
}

function selection(cwd = '/work'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('rewind file reads and journals reject unsafe paths, modes, and failed rollbacks', async () => {
  const cwd = await tempDir('ai-agents-rewind-gap-');
  const outside = await tempDir('ai-agents-rewind-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  try {
    assert.deepEqual(await readSafeWorkspaceFile(cwd, 'missing.txt'), { text: null, mode: null });
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    assert.equal((await readSafeWorkspaceFile(cwd, 'exact.txt')).text?.length, 500_000);
    assert.equal((await readSafeWorkspaceFile(cwd, 'exact.txt')).mode, 0o640);
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'over.txt'), /not a small regular file/);
    await writeFile(path.join(cwd, 'growing.txt'), 'initial contents');
    await assert.rejects(readSafeWorkspaceFile(cwd, 'growing.txt', async () => Buffer.alloc(500_001, 0x78)), /not a small regular file/);
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'nul.txt'), /binary/);
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'bad.txt'), /UTF-8/);
    await symlink(secret, path.join(cwd, 'link.txt'));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'link.txt'), /not a small regular file/);
    await assert.rejects(readSafeWorkspaceFile(cwd, 'missing/a.txt'), /parent directory is missing/);
    await writeFile(path.join(cwd, 'not-dir.txt'), 'x');
    await assert.rejects(readSafeWorkspaceFile(cwd, 'not-dir.txt/child.txt'), /non-directory or symlink/);
    await mkdir(path.join(cwd, 'locked'));
    await chmod(path.join(cwd, 'locked'), 0o000);
    await assert.rejects(readSafeWorkspaceFile(cwd, 'locked/a.txt'), { code: 'EACCES' });
    await chmod(path.join(cwd, 'locked'), 0o700);
    assert.throws(() => workspaceRelativePath(cwd, '../secret.txt'), /not safely restorable/);
    const fileMode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'after', { mode: fileMode });
    const snapshot = { path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: fileMode, afterMode: fileMode };
    const saved = capturedTurn('t1', cwd, [snapshot]);
    await assert.rejects(buildTurnRewindPlan([saved], 'missing', cwd), /no longer in this conversation/);
    await assert.rejects(buildTurnRewindPlan([], 'missing', cwd), /no longer in this conversation/);
    await assert.rejects(buildTurnRewindPlan([{ ...saved, fileCheckpoint: { status: 'unsupported', files: [] } }], 't1', cwd), /complete file checkpoint is unavailable/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, path: '.' }])], 't1', cwd), /Unsafe checkpoint path/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, path: '/tmp/a.txt' }])], 't1', cwd), /Unsafe checkpoint path/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeText: 'a\0b' }])], 't1', cwd), /Unsupported file snapshot/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeMode: 0o1000 }])], 't1', cwd), /Unsupported file mode/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeMode: -1 }])], 't1', cwd), /Unsupported file mode/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, afterMode: 1.5 }])], 't1', cwd), /Unsupported file mode/);
    const sameUser = capturedTurn('t1', cwd, [snapshot], { userMessageId: 't1' });
    const allowed = await buildTurnRewindPlan([sameUser], 't1', cwd);
    assert.equal(allowed.files.length, 1);
    const empty = await buildTurnRewindPlan([capturedTurn('t1', cwd, [])], 't1', cwd);
    assert.deepEqual(empty.files, []);
    const exact = 'x'.repeat(500_000);
    await writeFile(path.join(cwd, 'big.txt'), exact, { mode: fileMode });
    const bounded = await buildTurnRewindPlan([capturedTurn('t1', cwd, [
      { path: 'big.txt', beforeText: exact, afterText: exact, beforeMode: fileMode, afterMode: fileMode },
      { path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: fileMode, afterMode: fileMode },
    ])], 't1', cwd);
    assert.equal(bounded.files.length, 2);
    await writeFile(path.join(cwd, 'big.txt'), `${exact}y`);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [
      { path: 'big.txt', beforeText: exact, afterText: `${exact}y`, beforeMode: fileMode, afterMode: fileMode },
      { path: 'a.txt', beforeText: 'x', afterText: 'after', beforeMode: fileMode, afterMode: fileMode },
    ])], 't1', cwd), /safe size limit|Unsupported file snapshot/);
    await chmod(path.join(cwd, 'a.txt'), 0o755);
    await assert.rejects(buildTurnRewindPlan([saved], 't1', cwd), /changed after its checkpoint/);
    await chmod(path.join(cwd, 'a.txt'), fileMode);
    const journals = path.join(cwd, 'journals');
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const prepared = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, { ...plan, files: [] });
    assert.equal(prepared.journal.files.length, 0);
    await restoreTurnRewindFiles(prepared.journal);
    const readBack = await readTurnRewindJournal(prepared.path);
    assert.equal(readBack.version, 1);
    assert.equal(readBack.branchId, 'branch');
    await discardTurnRewindJournal(prepared.path);
    await discardTurnRewindJournal(prepared.path);
    const real = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, plan);
    real.journal.files[0]!.tempPath = path.join('nested', 'bad.tmp');
    await assert.rejects(restoreTurnRewindFiles(real.journal), /Invalid turn rewind journal/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    const modeLess = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, plan);
    modeLess.journal.files[0]!.beforeMode = null;
    await assert.rejects(restoreTurnRewindFiles(modeLess.journal), /no recorded mode/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    await writeFile(path.join(cwd, 'a.txt'), 'third', { mode: 0o640 });
    await writeFile(path.join(cwd, 'b.txt'), 'third-b', { mode: 0o640 });
    await assert.rejects(prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, {
      ...plan,
      files: [
        { path: 'a.txt', beforeText: 'before', beforeMode: fileMode, expectedText: 'after', expectedMode: fileMode },
        { path: 'b.txt', beforeText: 'before-b', beforeMode: fileMode, expectedText: 'after-b', expectedMode: fileMode },
      ],
    }), /changed before rewind began/);
    const crafted = {
      version: 1 as const, conversationId: 'conversation', branchId: 'branch', cwd,
      files: [
        { path: 'a.txt', beforeText: 'before', beforeMode: fileMode, expectedText: 'after', expectedMode: fileMode, backupText: 'after', backupMode: fileMode, tempPath: '.ai-agents-rewind-00000000-0000-4000-8000-000000000001.tmp' },
        { path: 'b.txt', beforeText: 'before-b', beforeMode: fileMode, expectedText: 'after-b', expectedMode: fileMode, backupText: 'after-b', backupMode: fileMode, tempPath: '.ai-agents-rewind-00000000-0000-4000-8000-000000000002.tmp' },
      ],
    };
    await assert.rejects(rollbackTurnRewindJournal(crafted), /a\.txt[\s\S]*b\.txt|b\.txt[\s\S]*a\.txt/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'third');
    assert.equal((await stat(path.join(cwd, 'a.txt'))).mode & 0o777, 0o644);
    await writeFile(path.join(cwd, 'a.txt'), 'before', { mode: fileMode });
    await rollbackTurnRewindJournal({ ...crafted, files: [crafted.files[0]!] });
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    const tempFile = path.join(cwd, crafted.files[0]!.tempPath);
    await writeFile(tempFile, 'interrupted temporary write');
    await rollbackTurnRewindJournal({ ...crafted, files: [crafted.files[0]!] });
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    await assert.rejects(readFile(tempFile), { code: 'ENOENT' });
    await writeFile(path.join(journals, 'bad.json'), '{');
    await assert.rejects(readTurnRewindJournal(path.join(journals, 'bad.json')), SyntaxError);
    const asDir = path.join(journals, 'directory.json');
    await mkdir(asDir);
    await assert.rejects(discardTurnRewindJournal(asDir), (error: NodeJS.ErrnoException) => error.code === 'EPERM' || error.code === 'EISDIR');
    assert.equal((await lstat(asDir)).isDirectory(), true);
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});;
