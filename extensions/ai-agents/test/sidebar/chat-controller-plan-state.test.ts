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

test('restored plans keep only settled phases actionable and cannot overwrite an already restored plan', async () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.restorePlan({ phase: 'idle', revisions: [] });
  assert.equal(controller.snapshot().plan.current, undefined);

  for (const phase of ['planning', 'revising', 'building', 'unknown', 'idle'] as const) {
    const restoredController = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
    const source = restoredPlan(phase);
    restoredController.restorePlan(source);
    const restored = restoredController.snapshot();
    assert.equal(restored.plan.phase, 'unknown');
    assert.equal(restored.plan.draft, undefined);
    assert.equal(restored.plan.current?.restored, true);
    assert.deepEqual(restored.todos, source.current?.todos);
    await assert.rejects(() => restoredController.build('saved-plan', 3, selection), /準備ができていません/);
  }

  controller.restorePlan(restoredPlan('implemented'));
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  assert.equal(controller.snapshot().plan.current?.id, 'saved-plan');
  controller.restorePlan(restoredPlan('ready'));
  assert.equal(controller.snapshot().plan.phase, 'implemented');

  const readyController = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  readyController.restorePlan(restoredPlan('ready'));
  assert.equal(readyController.snapshot().plan.phase, 'ready');
  assert.equal(readyController.snapshot().plan.current?.restored, true);
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

test('late Plan and To-do updates from an older turn cannot contaminate a revision, and failed revisions preserve the last committed plan', async () => {
  let backgroundUpdate!: (update: AgentUpdate) => void;
  let revisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { revisionStarted = resolve; });
  let releaseRevision!: () => void;
  const revisionGate = new Promise<void>((resolve) => { releaseRevision = resolve; });
  const controller = new ChatController(selection, async () => ({
    sessionId: 'plan-revision-notifications',
    subscribeBackgroundUpdates(emit) { backgroundUpdate = emit; return () => {}; },
    async run(prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'plan-v1', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Committed plan v1', todos: [{ content: 'v1 task', status: 'pending' }], source: 'assistant-text' } } });
        emit({ id: 'todo-v1', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'todo', todos: [{ content: 'v1 task', status: 'pending' }] } });
      } else if (prompt === 'revise plan') {
        emit({ id: 'late-old-plan-live', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'stale live plan v1', source: 'assistant-text' } } });
        emit({ id: 'late-old-todo-live', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'todo', todos: [{ content: 'stale live task', status: 'completed' }] } });
        revisionStarted();
        await revisionGate;
        emit({ id: 'plan-v2', backendTurnId: 'backend-2', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Committed plan v2', todos: [{ content: 'v2 task', status: 'pending' }], source: 'assistant-text' } } });
      } else if (prompt === 'fail revision') {
        emit({ id: 'partial-v3', backendTurnId: 'backend-3', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'uncommitted partial v3', source: 'assistant-text' } } });
        throw new Error('revision failed');
      }
    },
    async dispose() {},
  }), () => {});

  try {
    controller.setModePreference('plan');
    await controller.send('create plan');
    const firstPlan = controller.snapshot().plan.current!;
    assert.equal(firstPlan.revision, 1);

    const revising = controller.send('revise plan');
    await started;
    backgroundUpdate({ id: 'late-old-plan', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'stale plan v1', source: 'assistant-text' } } });
    backgroundUpdate({ id: 'late-old-todo', backendTurnId: 'backend-1', role: 'status', text: '', meta: { type: 'todo', todos: [{ content: 'stale task', status: 'completed' }] } });
    let state = controller.snapshot();
    assert.equal(state.plan.draft, undefined, 'a notification from the completed turn cannot become the active revision draft');
    assert.equal(state.plan.current?.markdown, 'Committed plan v1');
    assert.equal(state.plan.current?.todos[0]?.content, 'v1 task');
    assert.equal(state.todos[0]?.content, 'v1 task');
    assert.ok(!state.messages.some((message) => message.text.includes('stale plan v1')));

    releaseRevision();
    await revising;
    state = controller.snapshot();
    assert.equal(state.plan.current?.revision, 2);
    assert.equal(state.plan.current?.markdown, 'Committed plan v2');
    assert.equal(state.plan.current?.todos[0]?.content, 'v2 task');

    await controller.send('fail revision');
    state = controller.snapshot();
    assert.equal(state.plan.phase, 'ready');
    assert.equal(state.plan.current?.revision, 2);
    assert.equal(state.plan.current?.markdown, 'Committed plan v2');
    assert.equal(state.plan.draft, undefined);
    assert.ok(state.messages.some((message) => message.role === 'error' && message.text.includes('revision failed')));
  } finally {
    releaseRevision();
    await controller.dispose();
  }
});

test('a failed Build preserves the ready plan and allows only a later explicit Build to resume it', async () => {
  let buildCount = 0;
  const buildSelections: string[] = [];
  const controller = new ChatController(selection, async () => ({
    sessionId: 'build-recovery',
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'recoverable-plan', backendTurnId: 'plan-turn', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Preserve this plan', source: 'assistant-text' } } });
      } else if (turn?.intent === 'build') {
        buildCount += 1;
        buildSelections.push(turn.selection.model);
        if (buildCount === 1) throw new Error('build unavailable');
      }
    },
    async dispose() {},
  }), () => {});

  controller.setModePreference('plan');
  await controller.send('create plan');
  const plan = controller.snapshot().plan.current!;
  const buildSelection = { ...selection, model: 'builder-model' };
  await controller.build(plan.id, plan.revision, buildSelection);
  let state = controller.snapshot();
  assert.equal(buildCount, 1);
  assert.equal(state.plan.phase, 'ready');
  assert.equal(state.plan.current?.id, plan.id);
  assert.equal(state.plan.current?.revision, plan.revision);
  assert.equal(state.plan.current?.markdown, 'Preserve this plan');
  assert.ok(state.messages.some((message) => message.role === 'error' && message.text.includes('build unavailable')));

  await controller.build(plan.id, plan.revision, buildSelection);
  state = controller.snapshot();
  assert.equal(buildCount, 2, 'retry is a separate explicit Build dispatch');
  assert.deepEqual(buildSelections, ['builder-model', 'builder-model']);
  assert.equal(state.selection.model, 'builder-model');
  assert.equal(state.plan.phase, 'implemented');
  await controller.dispose();
});
