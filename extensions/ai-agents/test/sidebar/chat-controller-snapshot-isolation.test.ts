import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, Selection } from '../../src/types.js';

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
