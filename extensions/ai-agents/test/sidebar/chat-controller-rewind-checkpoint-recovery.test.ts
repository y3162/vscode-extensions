import assert from 'node:assert/strict';

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('checkpoint completion tolerates a stale callback after reset has removed its turn', async () => {
  let publishes = 0;
  const controller = new ChatController(selection(), async () => ({ async run() {}, async dispose() {} }), () => { publishes += 1; });
  await controller.send('finished');
  const turnId = controller.snapshot().turns[0]!.id;
  await controller.reset();
  const afterReset = controller.snapshot();
  const publishedAfterReset = publishes;

  await (controller as unknown as { captureTurnFileCheckpoint(id: string): Promise<void> }).captureTurnFileCheckpoint(turnId);

  assert.deepEqual(controller.snapshot(), afterReset, 'a stale checkpoint callback cannot recreate a cleared turn');
  assert.equal(publishes, publishedAfterReset, 'the no-op does not publish a phantom update');
  await controller.dispose();
});

test('a later checkpoint accounts for legacy turns that predate file checkpoints', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-legacy-turn-')));
  const file = path.join(cwd, 'created.txt');
  const legacy = new ChatController(selection(cwd), async () => ({ async run() {}, async dispose() {} }), () => {});
  const upgraded = new ChatController(selection(cwd), async () => ({
    sessionId: 'upgraded-thread',
    latestBackendTurnId: () => 'backend-new',
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id) { return `branch-${id}`; },
    async run(_prompt, _signal, emit) {
      await writeFile(file, 'new content\n', { mode: 0o640 });
      emit({ id: 'workspace-changes:new', backendTurnId: 'backend-new', role: 'tool', text: 'created', meta: { type: 'files', files: [
        { path: 'created.txt', kind: 'add', previousText: null, previousMode: null },
      ] } });
    },
    async dispose() {},
  }), () => {});
  try {
    await legacy.send('legacy turn');
    const saved = legacy.snapshot();
    assert.equal(saved.turns[0]?.fileCheckpoint, undefined);
    upgraded.restoreSnapshot(saved, 'upgraded-thread');

    await upgraded.send('new checkpointed turn');

    assert.equal(upgraded.snapshot().turns[0]?.fileCheckpoint, undefined);
    assert.equal(upgraded.snapshot().turns[1]?.fileCheckpoint?.status, 'captured');
    assert.equal(upgraded.snapshot().turns[1]?.fileCheckpoint?.files[0]?.afterText, 'new content\n');
  } finally {
    await legacy.dispose();
    await upgraded.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rewinding an empty later checkpoint preserves earlier file metadata and reports the absent restored file', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-empty-checkpoint-')));
  const file = path.join(cwd, 'note.txt');
  const mode = 0o640;
  await writeFile(file, 'seed\n', { mode });
  let sessionId = 'thread';
  let backendTurnId = 'backend-one';
  const controller = new ChatController(selection(cwd), async () => ({
    get sessionId() { return sessionId; },
    activateFork(id) { sessionId = id; },
    latestBackendTurnId: () => backendTurnId,
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id) { return `branch-${id}`; },
    async run(prompt, _signal, emit) {
      if (prompt === 'delete') {
        await rm(file);
        backendTurnId = 'backend-one';
        emit({ id: 'workspace-changes:first', backendTurnId, role: 'tool', text: 'deleted', meta: { type: 'files', files: [
          { path: 'note.txt', kind: 'delete', previousText: 'seed\n', previousMode: mode },
        ] } });
      } else if (prompt === 'confirm absent') {
        backendTurnId = 'backend-two';
        emit({ id: 'workspace-changes:second', backendTurnId, role: 'tool', text: 'still deleted', meta: { type: 'files', files: [
          { path: 'note.txt', kind: 'delete', previousText: null, previousMode: null },
        ] } });
      }
    },
    async dispose() {},
  }), () => {}, {
    journalDirectory: path.join(cwd, 'journals'),
    conversationId: () => 'conversation',
    enabled: () => true,
    async flush() {},
  });
  try {
    await controller.send('delete');
    await controller.send('confirm absent');
    const turns = controller.snapshot().turns;
    assert.equal(turns[1]?.fileCheckpoint?.files[0]?.beforeText, null);

    await controller.rewindAndSend(turns[1]!.id, 'replacement');

    const change = controller.snapshot().changes.find((item) => item.path === file);
    assert.equal(change?.kind, 'delete');
    assert.equal(change?.additions, 0);
    assert.equal(change?.deletions, 1);
    await assert.rejects(import('node:fs/promises').then(({ access }) => access(file)));
    assert.equal(controller.snapshot().turns.length, 2, 'the retained prefix and replacement turn remain');
  } finally {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rewinding a turn with no matching file checkpoint keeps metadata from the retained prefix', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-prefix-change-')));
  const earlierPath = path.join(cwd, 'earlier.txt');
  let sessionId = 'thread';
  let latestBackendTurnId = 'backend-one';
  let enableFork = false;
  const controller = new ChatController(selection(cwd), async () => ({
    get sessionId() { return sessionId; },
    activateFork(id) { sessionId = id; },
    latestBackendTurnId: () => latestBackendTurnId,
    get forkBeforeTurn() {
      return enableFork ? async (id: string) => `branch-${id}` : undefined;
    },
    async listBackgroundTerminals() { return []; },
    async run(prompt, _signal, emit) {
      if (prompt === 'earlier change') {
        emit({ id: 'file-update', backendTurnId: 'backend-one', role: 'tool', text: 'earlier', meta: { type: 'files', files: [
          { path: 'earlier.txt', kind: 'add', previousText: null, previousMode: null },
        ] } });
      } else if (prompt === 'later clean turn') {
        enableFork = true;
        latestBackendTurnId = 'backend-two';
        emit({ id: 'workspace-changes:backend-two', backendTurnId: latestBackendTurnId, role: 'tool', text: 'complete empty diff', meta: { type: 'files', files: [] } });
      }
    },
    async dispose() {},
  }), () => {}, {
    journalDirectory: path.join(cwd, 'journals'),
    conversationId: () => 'conversation',
    enabled: () => true,
    async flush() {},
  });
  try {
    await controller.send('earlier change');
    await controller.send('later clean turn');
    assert.equal(controller.snapshot().turns[0]?.fileCheckpoint, undefined);
    assert.deepEqual(controller.snapshot().turns[1]?.fileCheckpoint?.files, []);

    await controller.rewindAndSend(controller.snapshot().turns[1]!.id, 'replacement');

    assert.deepEqual(controller.snapshot().changes.map((change) => ({ path: change.path, kind: change.kind, previousText: change.previousText })), [
      { path: earlierPath, kind: 'add', previousText: null },
    ]);
    assert.equal(controller.snapshot().turns.length, 2);
  } finally {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an unsupported rewind backend can provide its own reason without a fork method', async () => {
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'unsupported-thread',
    rewindUnsupportedReason: () => 'Branching is disabled by this backend.',
    async run() {},
    async dispose() {},
  }), () => {}, {
    journalDirectory: '/tmp/unused-rewind-journals',
    conversationId: () => 'conversation',
    enabled: () => true,
    async flush() {},
  });
  try {
    await controller.send('complete turn');
    await assert.rejects(controller.previewRewind(controller.snapshot().turns[0]!.id), /Branching is disabled/);
    assert.equal(controller.snapshot().turns.length, 1);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    await controller.dispose();
  }
});
