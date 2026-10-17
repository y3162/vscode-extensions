import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { instructionSummary, searchWorkspace } from '../../src/vscode-context.js';
import { buildShell } from '../../src/view-state.js';
import { capabilitiesFor, defaultControls } from '../../src/capabilities.js';
import { emptyPlanState, type ChatState, type Selection, type TurnRecord } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function state(extra: Partial<ChatState> = {}): ChatState {
  return {
    selection: baseSelection, busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null, plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    ...extra,
  };
}

function displayStatus(extra: Partial<ChatState>, locale: 'en' | 'ja' = 'en'): string {
  return buildShell({
    state: state(extra), folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'Fixture', hasModelDetails: false,
    capabilities: capabilitiesFor('codex', 'sdk'), controls: defaultControls('codex', 'sdk'), locale,
    tokens: { permission: null, plan: null, question: null }, backends: { codex: 'sdk', cursor: 'sdk' },
  }).statusText;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('status labels cover both locales for cancellation and restoration', () => {
  assert.equal(displayStatus({ status: 'cancelling' }), 'Stopping…');
  assert.equal(displayStatus({ status: 'cancelling' }, 'ja'), '停止中…');
  assert.equal(displayStatus({ status: 'restoring' }), 'Restoring…');
  assert.equal(displayStatus({ status: 'restoring' }, 'ja'), '復元中…');
});

test('workspace search ranks exact and non-exact filenames from synthetic workspace entries', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rank-'));
  try {
    await writeFile(path.join(cwd, 'needles'), 'prefix');
    await writeFile(path.join(cwd, 'needle-more'), 'contains');
    await writeFile(path.join(cwd, 'needle'), 'exact');
    const { Uri, workspace } = await import('../support/vscode-stub.js');
    workspace.findFilesResult = ['needle-more', 'needles', 'needle'].map((name) => Uri.file(path.join(cwd, name)));
    const matches = await searchWorkspace(cwd, 'needle');
    assert.equal(matches[0]?.token, 'needle', 'the exact token sorts before prefix and substring candidates');
    assert.deepEqual(new Set(matches.map((item) => item.token)), new Set(['needle', 'needles', 'needle-more']));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('instruction summary uses an injected empty home and reports the empty-state text deterministically', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-empty-workspace-'));
  const userHome = await mkdtemp(path.join(tmpdir(), 'ai-agents-empty-home-'));
  try {
    assert.equal(await instructionSummary(cwd, userHome), 'No AGENTS.md, rules, skills, or MCP config found.');
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(userHome, { recursive: true, force: true }),
    ]);
  }
});

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

test('similar backend error events update one error row and preserve its first visible text', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'error-1', role: 'error', text: 'Backend: request failed' });
      emit({ id: 'error-2', role: 'error', text: 'request failed' });
      emit({ id: 'error-3', role: 'error', text: 'Backend detail: Backend: request failed' });
    },
    async dispose() {},
  }), () => {});

  await controller.send('produce repeated error detail');
  const errors = controller.snapshot().messages.filter((message) => message.role === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.text, 'Backend: request failed');
  await controller.dispose();
});

test('explicit auto-approval resolves once, while stale plan and question decisions preserve error status', async () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.setAutoApprove(true);
  assert.equal(await controller.interactions.requestPermission({ id: 'auto', title: 'Write file', detail: 'safe.txt', kind: 'write' }), 'allow-once');
  assert.equal(controller.snapshot().pendingPermission, null);

  controller.setAutoApprove(false);
  const planWait = controller.interactions.requestPlan({ id: 'plan', plan: 'Review', todos: [] });
  controller.setStatus('error');
  controller.resolvePlan('wrong-id', 'accepted');
  assert.equal(controller.snapshot().pendingPlan?.id, 'plan');
  controller.resolvePlan('plan', 'rejected');
  assert.equal(await planWait, 'rejected');
  assert.equal(controller.snapshot().status, 'error');

  const questionWait = controller.interactions.requestAnswers({ id: 'question', questions: [] });
  controller.setStatus('error');
  controller.resolveAnswers('question', { choice: ['safe'] });
  assert.deepEqual(await questionWait, { choice: ['safe'] });
  assert.equal(controller.snapshot().status, 'error');
  await controller.dispose();
});

test('restored background messages retain session origin and session totals suppress default-source request totals', async () => {
  let background!: (update: import('../../src/types.js').AgentUpdate) => void;
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'background-thread',
    subscribeBackgroundUpdates(listener) { background = listener; return () => {}; },
    async run() {},
    async dispose() {},
  }), () => {});

  await controller.openSession();
  background({ id: 'child-1', role: 'status', text: 'Child started', meta: {
    type: 'subagent', subagent: { id: 'child', name: 'Child', status: 'running', background: true },
  } });
  background({ id: 'child-1', role: 'assistant', text: 'Child finished', meta: {
    type: 'subagent', subagent: { id: 'child', name: 'Child', status: 'completed', background: false },
  } });
  const childRows = controller.snapshot().messages.filter((message) => message.id === 'background-thread:child-1');
  assert.equal(childRows.length, 1);
  assert.equal(childRows[0]?.turnId, 'background-thread');
  assert.equal(childRows[0]?.text, 'Child finished');

  background({ id: 'session-total', role: 'status', text: '', meta: { type: 'usage', usage: {
    scope: 'session', inputTokens: 10, outputTokens: 2, totalTokens: 12,
  } } });
  background({ id: 'request-total', role: 'status', text: '', meta: { type: 'usage', usage: {
    scope: 'request', inputTokens: 900, outputTokens: 900, totalTokens: 1800,
  } } });
  assert.equal(controller.snapshot().usage?.totalTokens, 12);
  assert.equal(controller.snapshot().messages.some((message) => message.id.endsWith(':request-total')), false);
  await controller.dispose();
});

test('a closed session without its own id retains the resume id and unsubscribes background updates', async () => {
  let opened = 0;
  let disposed = 0;
  let unsubscribed = 0;
  const resumeIds: Array<string | undefined> = [];
  const controller = new ChatController(baseSelection, async (_selection, context) => {
    opened += 1;
    resumeIds.push(context?.resumeId);
    const closeAfterRun = opened === 1;
    return {
      get closed() { return closeAfterRun; },
      async run() {},
      subscribeBackgroundUpdates() { return () => { unsubscribed += 1; }; },
      async dispose() { disposed += 1; },
    };
  }, () => {});
  controller.prepareResume('retained-thread');

  await controller.send('finish on a closed backend');
  assert.equal(controller.hasSession(), false);
  assert.equal(controller.sessionId(), 'retained-thread');
  assert.equal(disposed, 1);
  assert.equal(unsubscribed, 1);
  await controller.openSession();
  assert.deepEqual(resumeIds, ['retained-thread', 'retained-thread']);
  await controller.dispose();
});

test('opening an already-closed restored session detaches its listener before resuming it', async () => {
  let opened = 0;
  let disposed = 0;
  let unsubscribed = 0;
  const resumeIds: Array<string | undefined> = [];
  const controller = new ChatController(baseSelection, async (_selection, context) => {
    opened += 1;
    resumeIds.push(context?.resumeId);
    const closed = opened === 1;
    return {
      sessionId: opened === 1 ? undefined : 'resumed-thread',
      get closed() { return closed; },
      async run() {},
      subscribeBackgroundUpdates() { return () => { unsubscribed += 1; }; },
      async dispose() { disposed += 1; },
    };
  }, () => {});
  controller.prepareResume('retained-thread');

  await controller.openSession();
  assert.equal(controller.hasSession(), true);
  await controller.openSession();
  assert.deepEqual(resumeIds, ['retained-thread', 'retained-thread']);
  assert.equal(controller.currentSession()?.sessionId, 'resumed-thread');
  assert.equal(disposed, 1);
  assert.equal(unsubscribed, 1);
  await controller.dispose();
});

test('restore treats a rejected terminal snapshot as unknown but completes safely', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'terminal-error-thread',
    async run() {},
    async listBackgroundTerminals() { throw new Error('temporary terminal listing failure'); },
    async dispose() {},
  }), () => {});
  await controller.openSession();
  assert.equal(controller.snapshot().status, 'idle');
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().messages.some((message) => message.text.includes('temporary terminal listing failure')), false);
  await controller.dispose();
});

test('restoration drains input queued while transcript loading was pending', async () => {
  let transcriptStarted!: () => void;
  const loading = new Promise<void>((resolve) => { transcriptStarted = resolve; });
  let finishTranscript!: () => void;
  const transcriptGate = new Promise<void>((resolve) => { finishTranscript = resolve; });
  let runStarted!: () => void;
  const running = new Promise<void>((resolve) => { runStarted = resolve; });
  const prompts: string[] = [];
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'restore-queue-thread',
    async loadTranscript() { transcriptStarted(); await transcriptGate; },
    async run(prompt) { prompts.push(prompt); runStarted(); },
    async dispose() {},
  }), () => {});

  const opening = controller.openSession();
  await loading;
  controller.enqueue('queued during restoration');
  assert.equal(controller.snapshot().queue.length, 1);
  finishTranscript();
  await opening;
  await running;
  assert.deepEqual(prompts, ['queued during restoration']);
  await controller.dispose();
});

test('Build with an empty model uses the explicit default label and preserves the selected plan', async () => {
  const prompts: string[] = [];
  const controller = new ChatController(baseSelection, async () => ({
    async run(prompt, _signal, emit, _extras, turn) {
      prompts.push(prompt);
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: '', meta: {
        type: 'plan', plan: { markdown: 'Implement the default path', source: 'assistant-text' },
      } });
    },
    async dispose() {},
  }), () => {});
  controller.setModePreference('plan');
  await controller.send('prepare implementation');
  const plan = controller.snapshot().plan.current!;
  await controller.build(plan.id, plan.revision, { ...baseSelection, model: '' });
  const state = controller.snapshot();
  assert.equal(state.messages.find((message) => message.role === 'user' && message.text.startsWith('Build'))?.text, 'Build · default');
  assert.equal(state.turns.at(-1)?.model, '');
  assert.equal(state.plan.phase, 'implemented');
  assert.equal(prompts.length, 2);
  await controller.dispose();
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
});
