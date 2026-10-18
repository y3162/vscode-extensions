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
