import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';
import type { AgentSession, Selection } from '../../src/types.js';

const mode = 0o644;
const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

test('planSnapshot returns a detached copy that cannot mutate controller state', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'plan-snapshot-thread',
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'draft', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Keep this plan', source: 'assistant-text' } } });
      }
    },
    async dispose() {},
  }), () => {});

  try {
    controller.setModePreference('plan');
    await controller.send('prepare plan');
    const detached = controller.planSnapshot();
    assert.equal(detached.current?.markdown, 'Keep this plan');
    detached.current!.markdown = 'mutated by caller';
    assert.equal(controller.snapshot().plan.current?.markdown, 'Keep this plan');
  } finally {
    await controller.dispose();
  }
});

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

test('a Build model setup failure restores the saved plan and releases controller state', async () => {
  const prompts: Array<{ prompt: string; intent?: string }> = [];
  let modelUpdates = 0;
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'build-setup-thread',
    async setModel() { modelUpdates += 1; throw new Error('model setup failed'); },
    async run(prompt, _signal, emit, _extras, turn) {
      prompts.push({ prompt, intent: turn?.intent });
      if (turn?.intent === 'plan') {
        emit({ id: 'draft', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Keep the plan on setup failure', source: 'assistant-text' } } });
      }
    },
    async dispose() {},
  }), () => {});

  try {
    controller.setModePreference('plan');
    await controller.send('prepare plan');
    const savedPlan = controller.snapshot().plan.current;
    assert.ok(savedPlan);

    await controller.build(savedPlan.id, savedPlan.revision, baseSelection);

    const state = controller.snapshot();
    assert.equal(modelUpdates, 1);
    assert.deepEqual(prompts.map((item) => item.intent), ['plan']);
    assert.equal(state.turns.at(-1)?.intent, 'build');
    assert.equal(state.turns.at(-1)?.status, 'failed');
    assert.equal(state.plan.phase, 'ready');
    assert.equal(state.plan.current?.id, savedPlan.id);
    assert.equal(state.busy, false);
    assert.equal(state.status, 'error');
    assert.equal(state.queue.length, 0);
    assert.equal(state.messages.filter((message) => message.role === 'error').at(-1)?.text, 'model setup failed');
  } finally {
    await controller.dispose();
  }
});

test('a rejected send restores a ready plan and rethrows the original Build failure', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'build-send-thread',
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'draft', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Keep the plan if send rejects', source: 'assistant-text' } } });
      }
    },
    async dispose() {},
  }), () => {});

  try {
    controller.setModePreference('plan');
    await controller.send('prepare plan');
    const savedPlan = controller.snapshot().plan.current;
    assert.ok(savedPlan);
    controller.send = async () => { throw new Error('send infrastructure failure'); };

    await assert.rejects(controller.build(savedPlan.id, savedPlan.revision, baseSelection), /send infrastructure failure/);

    const state = controller.snapshot();
    assert.equal(state.plan.phase, 'ready');
    assert.equal(state.plan.current?.id, savedPlan.id);
    assert.equal(state.busy, false);
    assert.equal(state.queue.length, 0);
  } finally {
    await controller.dispose();
  }
});
