import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, Selection } from '../../src/types.js';

const mode = 0o644;

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

test('rewind keeps a restored out-of-workspace change visible and never touches that file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-boundary-'));
  const cwd = await realpath(root);
  const workspace = path.join(cwd, 'project');
  const journals = path.join(root, 'journals');
  await mkdir(workspace);
  const insideFile = path.join(workspace, 'safe.txt');
  const outsideFile = path.join(root, 'outside.txt');
  await writeFile(insideFile, 'before\n', { mode });
  await writeFile(outsideFile, 'private\n', { mode: 0o640 });
  const selection: Selection = { ...baseSelection, cwd: workspace };
  let sessionId = 'thread';
  const session: AgentSession = {
    get sessionId() { return sessionId; },
    async forkBeforeTurn() { return 'thread-branch'; },
    activateFork(id) { sessionId = id; },
    async listBackgroundTerminals() { return []; },
    async run(prompt, _signal, emit) {
      if (prompt === 'original') {
        await writeFile(insideFile, 'after\n', { mode });
        await chmod(insideFile, mode);
        emit({ id: 'workspace-changes:backend-1', backendTurnId: 'backend-1', role: 'tool', text: 'safe.txt', meta: {
          type: 'files', files: [{ path: 'safe.txt', kind: 'update', previousText: 'before\n', previousMode: mode }],
        } });
      }
      emit({ id: `answer:${prompt}`, backendTurnId: 'backend-1', role: 'assistant', text: `answer:${prompt}` });
    },
    async dispose() {},
  };
  const persistence: RewindPersistence = {
    journalDirectory: journals,
    conversationId: () => 'conversation',
    enabled: () => true,
    async flush() {},
  };
  const controller = new ChatController(selection, async () => session, () => {}, persistence);

  try {
    await controller.send('original');
    const restored = controller.snapshot();
    const turn = restored.turns[0];
    assert.ok(turn?.fileCheckpoint?.status === 'captured');
    restored.changes.push({ path: outsideFile, kind: 'update', previousText: 'private\n', previousMode: 0o640, mode: 0o640 });
    controller.restoreSnapshot(restored, 'thread');

    await controller.rewindAndSend(turn.id, 'edited prompt');

    assert.equal(await readFile(insideFile, 'utf8'), 'before\n');
    assert.equal(await readFile(outsideFile, 'utf8'), 'private\n');
    assert.equal((await lstat(outsideFile)).mode & 0o777, 0o640);
    assert.ok(controller.snapshot().changes.some((change) => change.path === outsideFile));
    assert.equal(controller.sessionId(), 'thread-branch');
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().status, 'idle');
    assert.equal(controller.snapshot().operationLabel, undefined);
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
