import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import { emptyPlanState, type ChatState, type Selection, type TurnRecord } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

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
});;;;;

test('restoring a planning run preserves its saved draft after attaching', async () => {
  let controller!: ChatController;
  const turn: TurnRecord = { id: 'plan-run', startedAt: 1, status: 'running', waitMs: 0,
    mode: 'plan', model: 'fixture', intent: 'plan' };
  controller = new ChatController(baseSelection, async () => ({
    sessionId: 'plan-thread',
    async run() {},
    async recoverRun(_id, _signal, _emit, attached) {
      attached();
      assert.equal(controller.snapshot().plan.phase, 'planning');
      assert.equal(controller.snapshot().plan.draft?.markdown, 'Saved draft');
      return false;
    },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.turns = [turn];
  saved.plan = { ...emptyPlanState(), phase: 'planning', draft: { id: 'draft', revision: 1,
    markdown: 'Saved draft', todos: [], source: 'assistant-text', createdAt: 1 } };
  controller.restoreSnapshot(saved, 'plan-thread');
  await controller.openSession();
  await controller.dispose();
});

test('failed attached recovery records its failure without claiming completion', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'failed-thread',
    async run() {},
    async recoverRun(_id, _signal, _emit, attached) {
      attached();
      throw Object.assign(new Error('owner failed'), { executionStatus: 'failed' });
    },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.turns = [{ id: 'failed-run', startedAt: 1, status: 'running', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat' }];
  controller.restoreSnapshot(saved, 'failed-thread');
  await controller.openSession();
  assert.equal(controller.snapshot().turns[0]?.status, 'failed');
  await controller.dispose();
});

test('cancelled attached recovery records cancellation', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'cancelled-thread',
    async run() {},
    async recoverRun(_id, _signal, _emit, attached) {
      attached();
      throw Object.assign(new Error('cancelled by owner'), { executionStatus: 'cancelled' });
    },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.turns = [{ id: 'cancelled-run', startedAt: 1, status: 'running', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat' }];
  controller.restoreSnapshot(saved, 'cancelled-thread');
  await controller.openSession();
  assert.equal(controller.snapshot().turns[0]?.status, 'cancelled');
  await controller.dispose();
});

test('a recovery error before attachment keeps the turn unknown', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'unavailable-thread',
    async run() {},
    async recoverRun() { throw new Error('owner unavailable'); },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.turns = [{ id: 'unavailable-run', startedAt: 1, status: 'running', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'plan' }];
  controller.restoreSnapshot(saved, 'unavailable-thread');
  await controller.openSession();
  assert.equal(controller.snapshot().turns[0]?.status, 'unknown');
  assert.equal(controller.snapshot().plan.phase, 'unknown');
  await controller.dispose();
});

test('transcript replay maps child and local parent ids into the saved turn', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'replay-thread',
    async run() {},
    async loadTranscript(emit) {
      emit({ id: 'remote-child', backendId: 'remote-child', backendTurnId: 'backend-turn',
        role: 'assistant', text: 'child answer', subagentId: 'child', final: true });
      for (const [id, parentTurnId] of [['local-parent', 'local-turn'], ['unknown-parent', 'missing-turn']] as const) {
        emit({ id, backendId: id, backendTurnId: 'backend-turn', role: 'status', text: id,
          meta: { type: 'subagent', subagent: { id, name: id, status: 'completed', background: 'unknown', parentTurnId } } });
      }
    },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.turns = [{ id: 'local-turn', backendTurnId: 'backend-turn', startedAt: 1, status: 'completed', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat' }];
  controller.restoreSnapshot(saved, 'replay-thread');
  await controller.openSession();
  const snapshot = controller.snapshot();
  assert.ok(snapshot.messages.some((message) => message.id === 'local-turn:child:child:remote-child'));
  assert.equal(snapshot.subagents.find((child) => child.id === 'local-parent')?.parentTurnId, 'local-turn');
  await controller.dispose();
});
