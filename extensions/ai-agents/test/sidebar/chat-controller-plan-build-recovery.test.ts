import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, Selection } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

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
