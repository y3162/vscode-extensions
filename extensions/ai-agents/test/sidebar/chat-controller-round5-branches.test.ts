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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

test('review is blocked while changing the model', async () => {
  const entered = deferred();
  const release = deferred();
  let reviewed = 0;
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async setModel() { entered.resolve(); await release.promise; },
    async review() { reviewed += 1; },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('open session');
    const changing = controller.updateSelection({ ...selection(), model: 'next' });
    await entered.promise;
    await assert.rejects(controller.review('base'), /実行中です/);
    assert.equal(reviewed, 0);
    release.resolve();
    await changing;
    assert.equal(controller.snapshot().selection.model, 'next');
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('Build rejects a provider or workspace change before mutating the plan or opening another session', async () => {
  const runs: string[] = [];
  let opens = 0;
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      async run(prompt, _signal, emit, _extras, turn) {
        runs.push(prompt);
        if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Keep this plan', source: 'assistant-text' } } });
      },
      async dispose() {},
    };
  }, () => {});
  controller.setModePreference('plan');
  try {
    await controller.send('prepare');
    const plan = controller.snapshot().plan.current!;
    await assert.rejects(controller.build(plan.id, plan.revision, { ...selection(), cwd: '/other-workspace' }), /同じ会話/);
    await assert.rejects(controller.build(plan.id, plan.revision, { ...selection(), provider: 'cursor' }), /同じ会話/);
    assert.equal(controller.snapshot().plan.phase, 'ready');
    assert.deepEqual(runs, ['prepare']);
    assert.equal(opens, 1);
  } finally {
    await controller.dispose();
  }
});

test('interaction resolvers reject stale ids and tokens while preserving non-waiting error state', async () => {
  const controller = new ChatController(selection(), async () => ({ async run() {}, async dispose() {} }), () => {});
  const planPromise = controller.interactions.requestPlan({ id: 'plan-id', plan: 'Plan', todos: [] });
  const planToken = controller.interactionTokens().plan!;
  controller.resolvePlan('other-plan', 'accepted', planToken);
  controller.resolvePlan('plan-id', 'accepted', 'stale-token');
  assert.equal(controller.snapshot().pendingPlan?.id, 'plan-id');
  controller.setStatus('error');
  controller.resolvePlan('plan-id', 'rejected');
  assert.equal(await planPromise, 'rejected');
  assert.equal(controller.snapshot().status, 'error');
  controller.resolvePlan('plan-id', 'accepted');

  const answerPromise = controller.interactions.requestAnswers({ id: 'question-id', questions: [] });
  const questionToken = controller.interactionTokens().question!;
  controller.resolveAnswers('other-question', {}, questionToken);
  controller.resolveAnswers('question-id', {}, 'stale-token');
  assert.equal(controller.snapshot().pendingQuestion?.id, 'question-id');
  controller.setStatus('error');
  controller.resolveAnswers('question-id', { q: ['answer'] });
  assert.deepEqual(await answerPromise, { q: ['answer'] });
  assert.equal(controller.snapshot().status, 'error');
  controller.resolveAnswers('question-id', {});
  await controller.dispose();
});

test('openSession waits for an in-flight reset and then opens the cleared conversation', async () => {
  const disposeEntered = deferred();
  const releaseDispose = deferred();
  let opens = 0;
  let disposals = 0;
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      async run() {},
      async dispose() {
        disposals += 1;
        if (disposals === 1) { disposeEntered.resolve(); await releaseDispose.promise; }
      },
    };
  }, () => {});
  try {
    await controller.send('before reset');
    const resetting = controller.reset();
    await disposeEntered.promise;
    const opening = controller.openSession();
    assert.equal(opens, 1, 'the session factory waits until reset releases the prior session');
    releaseDispose.resolve();
    await Promise.all([resetting, opening]);
    assert.equal(opens, 2);
    assert.equal(controller.hasSession(), true);
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    releaseDispose.resolve();
    await controller.dispose();
  }
});

test('openSession rejects a concurrent model update', async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async setModel() { entered.resolve(); await release.promise; },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('open session');
    const changing = controller.updateSelection({ ...selection(), model: 'next' });
    await entered.promise;
    await assert.rejects(controller.openSession(), /実行中です/);
    release.resolve();
    await changing;
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('duplicate reset calls share the same in-flight reset operation', async () => {
  const entered = deferred();
  const release = deferred();
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async dispose() { entered.resolve(); await release.promise; },
  }), () => {});
  await controller.send('session');
  const first = controller.reset();
  await entered.promise;
  const second = controller.reset();
  assert.equal(second, first);
  release.resolve();
  await Promise.all([first, second]);
  await controller.dispose();
});

test('a runtime session factory that violates its contract fails restoration without leaving a busy session', async () => {
  const invalidFactory = async () => undefined as unknown as AgentSession;
  const controller = new ChatController(selection(), invalidFactory, () => {});
  try {
    controller.prepareResume('retained-thread');
    await controller.openSession();
    assert.equal(controller.snapshot().status, 'error');
    assert.equal(controller.snapshot().messages.at(-1)?.role, 'error');
    assert.equal(controller.sessionId(), 'retained-thread');
    assert.equal(controller.hasSession(), false);
  } finally {
    await controller.dispose();
  }
});

test('background usage without a live turn is attributed to the session id and only updates aggregate usage', async () => {
  let background: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'background-session',
    subscribeBackgroundUpdates(listener) { background = listener; return () => { background = undefined; }; },
    async run() {},
    async dispose() {},
  }), () => {});
  try {
    await controller.openSession();
    background?.({ id: 'usage-event', role: 'status', text: 'usage', meta: { type: 'usage', usage: {
      inputTokens: 9, outputTokens: 2, totalTokens: 11, scope: 'run', source: 'background', sampleId: 'sample-1',
    } } });
    const state = controller.snapshot();
    const usageMessage = state.messages.find((item) => item.id === 'background-session:usage-event');
    assert.equal(usageMessage?.turnId, 'background-session');
    assert.equal(state.usage?.inputTokens, 9);
    assert.equal(state.usage?.scope, 'session');
    assert.equal(state.turns.length, 0);
  } finally {
    await controller.dispose();
  }
});

test('background updates use the current turn while running and the last completed turn afterward', async () => {
  let background: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'origin-session',
    subscribeBackgroundUpdates(listener) { background = listener; return () => { background = undefined; }; },
    async run() {
      background?.({ id: 'during-run', role: 'assistant', text: 'live event' });
    },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('one turn');
    const turnId = controller.snapshot().turns[0]!.id;
    assert.equal(controller.snapshot().messages.find((item) => item.id === `${turnId}:during-run`)?.turnId, turnId);

    background?.({ id: 'after-run', role: 'assistant', text: 'late event' });
    const state = controller.snapshot();
    assert.equal(state.messages.find((item) => item.id === `${turnId}:after-run`)?.turnId, turnId);
    assert.equal(state.turns.length, 1);
  } finally {
    await controller.dispose();
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

test('plan and question resolution keeps a running agent out of idle while interactions are released', async () => {
  const planVisible = deferred();
  const questionVisible = deferred();
  const decisions: unknown[] = [];
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => ({
    async run() {
      const plan = controller.interactions.requestPlan({ id: 'active-plan', plan: 'Plan', todos: [] });
      planVisible.resolve();
      decisions.push(await plan);
      const answers = controller.interactions.requestAnswers({ id: 'active-question', questions: [] });
      questionVisible.resolve();
      decisions.push(await answers);
    },
    async dispose() {},
  }), () => {});
  try {
    const sending = controller.send('needs input');
    await planVisible.promise;
    assert.equal(controller.snapshot().status, 'waiting_approval');
    controller.resolvePlan('active-plan', 'accepted', controller.interactionTokens().plan!);
    assert.equal(controller.snapshot().status, 'running');
    await questionVisible.promise;
    assert.equal(controller.snapshot().status, 'waiting_approval');
    controller.resolveAnswers('active-question', { first: ['yes'] }, controller.interactionTokens().question!);
    assert.equal(controller.snapshot().status, 'running');
    await sending;
    assert.deepEqual(decisions, ['accepted', { first: ['yes'] }]);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    await controller.dispose();
  }
});
