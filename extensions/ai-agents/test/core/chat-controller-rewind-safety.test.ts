import assert from 'node:assert/strict';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import { emptyPlanState, type ChatState, type Selection, type TurnRecord } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('rewind refuses backend-reported live terminals and missing later turn ids without changing history', async () => {
  const live = new ChatController(baseSelection, async () => ({
    sessionId: 'live-thread',
    async run(_prompt, _signal, emit) { emit({ id: 'answer', backendTurnId: 'backend-1', role: 'assistant', text: 'answer' }); },
    async forkBeforeTurn() { throw new Error('must not fork'); },
    async listBackgroundTerminals() { return [{ processId: 'terminal-1', status: 'running' }]; },
    async dispose() {},
  }), () => {}, { journalDirectory: '/tmp/unused-rewind-journals', conversationId: () => 'conversation', enabled: () => true, flush: async () => {} });
  await live.send('first turn');
  const liveBefore = live.snapshot();
  await assert.rejects(live.previewRewind(liveBefore.turns[0]!.id), /Background Terminal/);
  assert.deepEqual(live.snapshot().turns, liveBefore.turns);
  assert.equal(live.snapshot().busy, false);
  await live.dispose();

  let turnNumber = 0;
  const missingLaterId = new ChatController(baseSelection, async () => ({
    sessionId: 'turn-id-thread',
    async run(_prompt, _signal, emit) {
      turnNumber += 1;
      emit({ id: `answer-${turnNumber}`, backendTurnId: `backend-${turnNumber}`, role: 'assistant', text: `answer ${turnNumber}` });
    },
    async forkBeforeTurn() { throw new Error('must not fork'); },
    async listBackgroundTerminals() { return []; },
    async dispose() {},
  }), () => {}, { journalDirectory: '/tmp/unused-rewind-journals', conversationId: () => 'conversation', enabled: () => true, flush: async () => {} });
  await missingLaterId.send('first turn');
  await missingLaterId.send('second turn');
  const saved = missingLaterId.snapshot();
  saved.turns[1]!.backendTurnId = undefined;
  missingLaterId.restoreSnapshot(saved, 'turn-id-thread');
  await assert.rejects(missingLaterId.previewRewind(saved.turns[0]!.id), /後続ターンの Backend turn ID/);
  assert.equal(missingLaterId.snapshot().turns.length, 2);
  assert.equal(missingLaterId.snapshot().busy, false);
  await missingLaterId.dispose();
});

test('rewind refuses incomplete aggregate file history before restoring or switching sessions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-incomplete-history-'));
  const file = path.join(cwd, 'note.txt');
  let createdBranches = 0;
  let disposedBranches = 0;
  try {
    await writeFile(file, 'before');
    const persistence = {
      journalDirectory: path.join(cwd, 'journals'), conversationId: () => 'conversation', enabled: () => true, flush: async () => {},
    };
    const controller = new ChatController({ ...baseSelection, cwd }, async (_selection, context) => {
      if (context?.resumeId) {
        createdBranches += 1;
        return {
          sessionId: context.resumeId,
          async run() {}, async listBackgroundTerminals() { return []; },
          async dispose() { disposedBranches += 1; },
        };
      }
      return {
        sessionId: 'original-thread', latestBackendTurnId: () => 'backend-turn',
        async run(_prompt, _signal, emit) {
          await writeFile(file, 'after');
          emit({ id: 'workspace-changes:1', role: 'tool', text: 'updated', backendTurnId: 'backend-turn', meta: { type: 'files', files: [
            { path: 'note.txt', kind: 'update', previousText: 'before', previousMode: 0o644 },
          ] } });
        },
        async forkBeforeTurn() { return 'branch-thread'; },
        async listBackgroundTerminals() { return []; },
        async dispose() {},
      };
    }, () => {}, persistence);

    await controller.send('update note');
    const saved = controller.snapshot();
    const target = saved.turns[0]!.id;
    saved.changes = [{ path: 'note.txt', kind: 'update' }];
    controller.restoreSnapshot(saved, 'original-thread');
    const before = controller.snapshot();
    await assert.rejects(controller.rewindAndSend(target, 'revise note'), /aggregate file history.*has no baseline/);
    assert.equal(await readFile(file, 'utf8'), 'after');
    assert.equal(createdBranches, 1);
    assert.equal(disposedBranches, 1);
    assert.deepEqual(controller.snapshot().messages, before.messages);
    assert.equal(controller.sessionId(), 'original-thread');
    assert.equal(controller.snapshot().busy, false);
    await controller.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a snapshot restore is ignored while a rewind branch is opening', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-lock-'));
  const file = path.join(cwd, 'note.txt');
  const forkStarted = deferred();
  const forkGate = deferred();
  let disposedOldSession = 0;
  try {
    await writeFile(file, 'before');
    const controller = new ChatController({ ...baseSelection, cwd }, async (_selection, context) => {
      if (context?.resumeId) return {
        sessionId: context.resumeId,
        async run() {}, async listBackgroundTerminals() { return []; }, async dispose() {},
      };
      return {
        sessionId: 'rewind-lock-thread',
        async run(_prompt, _signal, emit) {
          await writeFile(file, 'after');
          emit({ id: 'workspace-changes:lock', role: 'tool', text: 'updated', backendTurnId: 'backend-lock', meta: { type: 'files', files: [
            { path: 'note.txt', kind: 'update', previousText: 'before', previousMode: 0o644 },
          ] } });
        },
        async forkBeforeTurn() { forkStarted.resolve(); await forkGate.promise; return 'rewind-lock-branch'; },
        async listBackgroundTerminals() { return []; },
        async dispose() { disposedOldSession += 1; },
      };
    }, () => {}, {
      journalDirectory: path.join(cwd, 'journals'), conversationId: () => 'conversation', enabled: () => true, flush: async () => {},
    });

    await controller.send('change note');
    const turn = controller.snapshot().turns[0]!;
    const rewinding = controller.rewindAndSend(turn.id, 'edit the note');
    await forkStarted.promise;
    const before = controller.snapshot();
    const attemptedRestore = structuredClone(before);
    attemptedRestore.messages = [];
    attemptedRestore.selection.model = 'stale-model';
    controller.restoreSnapshot(attemptedRestore, 'stale-thread');
    assert.deepEqual(controller.snapshot(), before, 'restoring stale history cannot replace state while rewind owns the conversation');

    forkGate.resolve();
    await rewinding;
    assert.equal(await readFile(file, 'utf8'), 'before');
    assert.equal(controller.sessionId(), 'rewind-lock-branch');
    assert.equal(controller.snapshot().messages.some((message) => message.role === 'user' && message.text === 'edit the note'), true);
    assert.equal(disposedOldSession, 1);
    await controller.dispose();
  } finally {
    forkGate.resolve();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('cumulative rewind checkpoint size limit preserves the newly completed turn as unsupported', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-checkpoint-limit-'));
  try {
    const inputFile = path.join(cwd, 'new.txt');
    const controller = new ChatController({ ...baseSelection, cwd }, async () => ({
      sessionId: 'checkpoint-thread',
      latestBackendTurnId: () => 'new-backend-turn',
      async run(_prompt, _signal, emit) {
        await writeFile(inputFile, 'after');
        emit({ id: 'workspace-changes:new', role: 'tool', text: 'Changed new.txt', meta: { type: 'files', files: [
          { path: 'new.txt', kind: 'add', previousText: null, previousMode: null },
        ] } });
      },
      async forkBeforeTurn() { return 'branch'; },
      async listBackgroundTerminals() { return []; },
      async dispose() {},
    }), () => {}, { journalDirectory: path.join(cwd, 'journals'), conversationId: () => 'conversation', enabled: () => true, flush: async () => {} });
    const prior = (id: string, file: string): TurnRecord => ({
      id, startedAt: 1, endedAt: 2, status: 'completed', waitMs: 0, mode: 'agent', model: 'fixture', intent: 'chat',
      backendTurnId: `backend-${id}`, planBefore: emptyPlanState(), todosBefore: [],
      fileCheckpoint: { status: 'captured', workspaceRoot: cwd, files: [{ path: file, beforeText: 'x'.repeat(4_000_000), afterText: '', beforeMode: 0o644, afterMode: 0o644 }] },
    });
    const saved = controller.snapshot();
    saved.turns = [prior('old-1', 'old-1.txt'), prior('old-2', 'old-2.txt')];
    controller.restoreSnapshot(saved, 'checkpoint-thread');

    await controller.send('write a small file');
    const current = controller.snapshot().turns.at(-1)!;
    assert.equal(current.fileCheckpoint?.status, 'unsupported');
    assert.match(current.fileCheckpoint?.reason ?? '', /conversation exceeds.*storage limit/i);
    assert.equal(await readFile(inputFile, 'utf8'), 'after', 'the rejected checkpoint never alters the workspace file');
    await controller.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});;;;;
