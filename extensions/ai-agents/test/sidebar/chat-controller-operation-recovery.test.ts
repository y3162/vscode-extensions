import assert from 'node:assert/strict';

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
