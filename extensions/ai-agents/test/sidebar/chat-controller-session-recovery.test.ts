import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, ChatMessage, Selection } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

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

test('a correlated final transcript completes an unknown restored turn without inventing its end time', async () => {
  const original = new ChatController(baseSelection, async () => ({
    sessionId: 'in-flight-thread',
    async run(_prompt, _signal, emit) {
      emit({ id: 'answer', backendId: 'answer', backendTurnId: 'backend-turn-1', role: 'assistant', text: 'partial answer' });
    },
    async dispose() {},
  }), () => {});
  await original.send('resume this turn');
  const saved = original.snapshot();
  const turn = saved.turns[0]!;
  const answer = saved.messages.find((message) => message.role === 'assistant')!;
  turn.status = 'running';
  delete turn.endedAt;
  delete turn.finalMessageId;
  answer.final = false;

  const finalMessage: ChatMessage = {
    id: 'answer', backendId: 'answer', backendTurnId: 'backend-turn-1',
    role: 'assistant', text: 'final answer from the same backend turn', final: true,
  };
  const restored = new ChatController(baseSelection, async () => ({
    sessionId: 'in-flight-thread',
    async loadTranscript(emit) { emit(finalMessage); },
    async run() {},
    async dispose() {},
  }), () => {});

  try {
    restored.restoreSnapshot(saved, 'in-flight-thread');
    assert.equal(restored.snapshot().turns[0]?.status, 'unknown');
    await restored.openSession();
    const state = restored.snapshot();
    const recovered = state.messages.find((message) => message.role === 'assistant');
    assert.equal(state.turns[0]?.status, 'completed');
    assert.equal(state.turns[0]?.endedAt, undefined, 'transcript load time is not a backend end timestamp');
    assert.equal(state.turns[0]?.finalMessageId, recovered?.id);
    assert.equal(recovered?.text, finalMessage.text);
    assert.equal(recovered?.final, true);
  } finally {
    await original.dispose();
    await restored.dispose();
  }
});
