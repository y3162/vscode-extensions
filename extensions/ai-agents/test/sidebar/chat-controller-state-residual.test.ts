import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import type { AgentSession, ChatMessage, Selection } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

test('a failed Build keeps the saved plan and releases busy state without retrying', async () => {
  const prompts: string[] = [];
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'build-thread',
    async run(prompt, _signal, emit, _extras, turn) {
      prompts.push(prompt);
      if (turn?.intent === 'plan') {
        emit({ id: 'plan-draft', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Implement safely', source: 'assistant-text' } } });
      } else if (turn?.intent === 'build') {
        throw new Error('compiler unavailable');
      }
    },
    async dispose() {},
  }), () => {});

  try {
    controller.setModePreference('plan');
    await controller.send('prepare a plan');
    const savedPlan = controller.snapshot().plan.current;
    assert.ok(savedPlan);
    assert.equal(controller.snapshot().plan.phase, 'ready');

    await controller.build(savedPlan.id, savedPlan.revision, baseSelection);

    const state = controller.snapshot();
    assert.equal(prompts.length, 2);
    assert.equal(state.turns.at(-1)?.intent, 'build');
    assert.equal(state.turns.at(-1)?.status, 'failed');
    assert.equal(state.plan.phase, 'ready');
    assert.equal(state.plan.current?.id, savedPlan.id);
    assert.equal(state.busy, false);
    assert.equal(state.status, 'error');
    assert.equal(state.queue.length, 0);
    assert.equal(state.messages.filter((message) => message.role === 'error').at(-1)?.text, 'compiler unavailable');
  } finally {
    await controller.dispose();
  }
});

test('a rejected model update preserves the old selection and a later update can recover', async () => {
  let rejectUpdate = true;
  let setModelCalls = 0;
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'model-thread',
    async run() {},
    async setModel() {
      setModelCalls += 1;
      if (rejectUpdate) throw new Error('model switch failed');
    },
    async dispose() {},
  }), () => {});

  try {
    await controller.send('keep the current conversation');
    const before = controller.snapshot();
    const next: Selection = { ...baseSelection, model: 'next-model', modelParams: [{ id: 'effort', value: 'high' }] };
    await assert.rejects(controller.updateSelection(next), /model switch failed/);
    assert.deepEqual(controller.snapshot().selection, before.selection);
    assert.deepEqual(controller.snapshot().messages, before.messages);
    assert.equal(controller.sessionId(), 'model-thread');
    assert.equal(controller.snapshot().busy, false);

    rejectUpdate = false;
    await controller.updateSelection(next);
    assert.deepEqual(controller.snapshot().selection, next);
    assert.equal(controller.sessionId(), 'model-thread');
    assert.equal(setModelCalls, 2);
  } finally {
    await controller.dispose();
  }
});

test('an externally closed session is disposed and reopened with its retained backend id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-closed-session-'));
  let firstClosed = false;
  let disposed = 0;
  const resumeIds: Array<string | undefined> = [];
  const controller = new ChatController({ ...baseSelection, cwd: root }, async (_selection, context) => {
    resumeIds.push(context?.resumeId);
    const first = resumeIds.length === 1;
    const session: AgentSession = {
      sessionId: first ? 'closed-thread' : 'reopened-thread',
      get closed() { return first && firstClosed; },
      async run(_prompt, _signal, emit) { emit({ id: 'answer', role: 'assistant', text: first ? 'first answer' : 'resumed answer' }); },
      async dispose() { disposed += 1; },
    };
    return session;
  }, () => {});

  try {
    await controller.send('first prompt');
    assert.equal(controller.sessionId(), 'closed-thread');
    firstClosed = true;
    await controller.openSession();

    assert.deepEqual(resumeIds, [undefined, 'closed-thread']);
    assert.equal(disposed, 1);
    assert.equal(controller.currentSession()?.sessionId, 'reopened-thread');
    assert.equal(controller.sessionId(), 'reopened-thread');
    assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['first prompt', 'first answer']);
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('restoration recovers a missing event for a locally known backend turn exactly once', async () => {
  const original = new ChatController(baseSelection, async () => ({
    sessionId: 'transcript-thread',
    async run(_prompt, _signal, emit) {
      emit({ id: 'saved-answer', backendTurnId: 'backend-turn-1', role: 'assistant', text: 'saved answer' });
    },
    async dispose() {},
  }), () => {});
  await original.send('saved user prompt');
  const snapshot = original.snapshot();
  const turn = snapshot.turns[0];
  assert.ok(turn?.backendTurnId);
  const user = snapshot.messages.find((message) => message.role === 'user');
  assert.ok(user);
  snapshot.messages = [user];

  const recoveredMessage: ChatMessage = {
    id: 'backend-tool-event', backendId: 'backend-tool-1', backendTurnId: turn.backendTurnId,
    role: 'tool', text: 'recovered tool output',
  };
  const restored = new ChatController(baseSelection, async () => ({
    sessionId: 'transcript-thread',
    async loadTranscript(emit) { emit(recoveredMessage); },
    async run() {},
    async dispose() {},
  }), () => {});

  try {
    restored.restoreSnapshot(snapshot, 'transcript-thread');
    await restored.openSession();
    const state = restored.snapshot();
    const recovered = state.messages.filter((message) => message.backendId === 'backend-tool-1');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, `${turn.id}:backend-tool-1`);
    assert.equal(recovered[0]?.turnId, turn.userMessageId ?? turn.id);
    assert.equal(recovered[0]?.backendTurnId, 'backend-turn-1');
    assert.equal(state.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(state.busy, false);
    assert.equal(state.status, 'idle');
  } finally {
    await original.dispose();
    await restored.dispose();
  }
});
