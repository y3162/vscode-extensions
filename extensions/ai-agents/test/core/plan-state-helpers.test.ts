import assert from 'node:assert/strict';

import { test } from 'node:test';

import { applyPlanTodos, beginPlanning, buildPrompt, cloneSelection, commitDraft, finishBuild, inferIntent, planningFailed, requestBuild, setBuildSelection, stageDraft, remapPlanAnchor } from '../../src/plan-state.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

function selection(cwd = '/work'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function planDocument(extra: Partial<PlanState['current']> = {}) {
  return {
    id: 'plan-1', revision: 1, markdown: 'Do the work', todos: [{ content: 'step', status: 'pending' }],
    source: 'assistant-text' as const, createdAt: 1, name: 'Name', overview: 'Overview', files: ['a.ts'], ...extra,
  };
}

test('Plan anchor is remapped only when its user message is unique in both histories', () => {
  const plan: PlanState = { phase: 'ready', revisions: [], current: planDocument({ turnId: 'old' }) };
  const saved = [{ id: 'old', role: 'user' as const, text: 'make plan' }];
  const replayed = [{ id: 'new', role: 'user' as const, text: 'make plan' }, { id: 'build', role: 'user' as const, text: 'build' }];
  assert.equal(remapPlanAnchor(plan, saved, replayed).current?.turnId, 'new');
  assert.equal(plan.current?.turnId, 'old');
  assert.equal(remapPlanAnchor(plan, saved, [...replayed, { id: 'other', role: 'user', text: 'make plan' }]).current?.turnId, 'old');
  assert.equal(remapPlanAnchor(plan, [...saved, { id: 'other', role: 'user', text: 'make plan' }], replayed).current?.turnId, 'old');
});

function readyPlan(phase: PlanState['phase'] = 'ready'): PlanState {
  return { phase, revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: 'Do the work', name: 'Name' }], current: planDocument(), build: { selection: selection(), label: 'Fixture' } };
}

test('plan helpers cover empty todos, build selection, and planning versus building intent', () => {
  const idle = emptyPlanState();
  assert.equal(applyPlanTodos(idle, []), idle);
  assert.equal(applyPlanTodos(idle, [{ content: 'x', status: 'pending' }]), idle);
  const drafted = stageDraft(idle, { markdown: '  Plan body  ', name: 'Named', overview: 'Why', files: ['a.ts'], todos: [{ content: 'old', status: 'pending' }], source: 'assistant-text' });
  assert.equal(drafted.draft?.markdown, 'Plan body');
  assert.equal(drafted.draft?.name, 'Named');
  assert.deepEqual(applyPlanTodos(drafted, []).draft?.todos, drafted.draft?.todos);
  assert.equal(applyPlanTodos(drafted, [{ content: 'new', status: 'completed' }]).draft?.todos[0]?.content, 'new');
  assert.equal(stageDraft(idle, { markdown: '   ', source: 'assistant-text' }), idle);
  const currentOnly = { ...idle, current: planDocument() };
  assert.equal(applyPlanTodos(currentOnly, [{ content: 'kept', status: 'pending' }]).current?.todos[0]?.content, 'kept');
  assert.equal(setBuildSelection(idle, selection()), idle);
  const noCurrent = { ...readyPlan(), current: undefined };
  assert.equal(setBuildSelection(noCurrent, selection()), noCurrent);
  const selected = setBuildSelection(readyPlan(), { ...selection(), model: 'other', modelParams: [{ id: 'effort', value: 'high' }] }, 'Other');
  assert.equal(selected.build?.label, 'Other');
  assert.equal(selected.build?.selection.model, 'other');
  assert.equal(setBuildSelection(readyPlan(), selection()).build?.label, undefined);
  assert.equal(inferIntent('agent', readyPlan('planning')), 'chat');
  assert.equal(inferIntent('plan', readyPlan('planning')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('building')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('idle')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('ready')), 'revise');
  assert.equal(inferIntent('plan', readyPlan('implemented')), 'revise');
  assert.equal(inferIntent('plan', readyPlan('revising')), 'revise');
  const building = requestBuild(readyPlan('building'), 'plan-1', 1, selection());
  assert.deepEqual(building, { error: '実装はすでに始まっています。' });
  assert.equal(beginPlanning(readyPlan('building')).phase, 'building');
  const revising = beginPlanning(readyPlan('implemented'));
  assert.equal(revising.phase, 'revising');
  assert.equal(revising.revisionBasePhase, 'implemented');
  assert.equal(planningFailed(revising).phase, 'implemented');
  assert.equal(planningFailed({ phase: 'planning', revisions: [] }).phase, 'idle');
  assert.equal(finishBuild(idle, 'completed').phase, 'idle');
  assert.equal(finishBuild(readyPlan('building'), 'cancelled').phase, 'ready');
  assert.equal(commitDraft(idle, selection()).error, '計画は作成されませんでした。');
  const committed = commitDraft(drafted, { ...selection(), modelParams: [{ id: 'effort', value: 'low' }] }, 'thread');
  assert.equal(committed.phase, 'ready');
  assert.equal(committed.current?.sessionId, 'thread');
  assert.equal(committed.build?.selection.modelParams?.[0]?.value, 'low');
  committed.build!.selection.modelParams![0]!.value = 'mutated';
  assert.equal(drafted.draft?.markdown, 'Plan body');
  const prompt = buildPrompt({ ...planDocument(), todos: [], name: undefined, overview: undefined });
  assert.equal(prompt.includes('To-dos'), false);
  assert.equal(prompt.includes('# Name'), false);
  assert.deepEqual(cloneSelection(selection()), selection());
  const cloned = cloneSelection({ ...selection(), modelParams: [{ id: 'effort', value: 'max' }] });
  cloned.modelParams![0]!.value = 'changed';
  assert.equal(cloned.modelParams?.[0]?.value, 'changed');
});;
