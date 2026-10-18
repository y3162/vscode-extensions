import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import { emptyPlanState, type ChatState, type Selection, type TurnRecord } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function state(extra: Partial<ChatState> = {}): ChatState {
  return {
    selection: baseSelection, busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null, plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    ...extra,
  };
}

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
});;
