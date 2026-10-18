import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

function restoredPlan(phase: ChatState['plan']['phase']): ChatState['plan'] {
  return {
    phase,
    revisions: [],
    draft: { id: 'draft', revision: 0, markdown: 'discard this draft', todos: [], source: 'assistant-text', createdAt: 1 },
    current: { id: 'saved-plan', revision: 3, markdown: 'saved plan', todos: [{ content: 'keep state', status: 'pending' }], source: 'assistant-text', createdAt: 2 },
  };
}

test('restored plans normalize transient phases and cannot overwrite an already restored plan', () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.restorePlan({ phase: 'idle', revisions: [] });
  assert.equal(controller.snapshot().plan.current, undefined);

  const source = restoredPlan('planning');
  controller.restorePlan(source);
  const restored = controller.snapshot();
  assert.equal(restored.plan.phase, 'ready');
  assert.equal(restored.plan.draft, undefined);
  assert.equal(restored.plan.current?.restored, true);
  assert.deepEqual(restored.todos, source.current?.todos);

  controller.restorePlan(restoredPlan('implemented'));
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().plan.current?.id, 'saved-plan');
});

test('a session without setMode refuses runtime mode changes but still remembers the initial preference', async () => {
  const modes: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, _emit, _extras, turn) { modes.push(turn?.mode ?? ''); },
    async dispose() {},
  }), () => {});

  assert.equal(await controller.applyMode('plan'), true, 'without a session the preference can be changed');
  await controller.send('use the remembered mode');
  assert.deepEqual(modes, ['plan']);
  assert.equal(await controller.applyMode('ask'), false, 'an open session without setMode cannot change execution mode');
  await controller.send('keep the remembered mode');
  assert.deepEqual(modes, ['plan', 'plan']);
  await controller.dispose();
});

test('a duplicate Build while the plan is already building does not start another turn', async () => {
  let enterBuild!: () => void;
  const buildEntered = new Promise<void>((resolve) => { enterBuild = resolve; });
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const prompts: string[] = [];
  const controller = new ChatController(selection, async () => ({
    sessionId: 'single-build',
    async run(prompt, _signal, emit, _extras, turn) {
      prompts.push(prompt);
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Build safely', source: 'assistant-text' } } });
      if (turn?.intent === 'build') {
        enterBuild();
        await buildGate;
      }
    },
    async dispose() {},
  }), () => {});

  controller.setModePreference('plan');
  await controller.send('prepare a plan');
  const plan = controller.snapshot().plan.current!;
  const firstBuild = controller.build(plan.id, plan.revision, selection);
  await buildEntered;
  assert.equal(controller.snapshot().plan.phase, 'building');
  await controller.build(plan.id, plan.revision, selection);
  assert.equal(prompts.length, 2);
  releaseBuild();
  await firstBuild;
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  await controller.dispose();
});
