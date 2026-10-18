import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, planningFailed } from '../../src/plan-state.js';
import { emptyPlanState, type PlanDocument } from '../../src/types.js';

const current: PlanDocument = {
  id: 'plan-1', revision: 2, markdown: 'Keep this plan', todos: [], source: 'assistant-text', createdAt: 1,
};

test('legacy plan failures restore the prior phase and keep the committed plan', () => {
  const implemented = {
    ...emptyPlanState(), phase: 'implemented' as const, current,
    draft: { ...current, markdown: 'partial replacement' },
  };
  const recoveredImplemented = planningFailed(implemented);
  assert.equal(recoveredImplemented.phase, 'implemented');
  assert.equal(recoveredImplemented.current, current);
  assert.equal(recoveredImplemented.draft, undefined);
  assert.equal(recoveredImplemented.error, undefined);

  const ready = { ...implemented, phase: 'revising' as const, current: { ...current, revision: 1 } };
  const recoveredReady = planningFailed(ready, 'revision failed');
  assert.equal(recoveredReady.phase, 'ready');
  assert.equal(recoveredReady.current?.markdown, current.markdown);
  assert.equal(recoveredReady.error, 'revision failed');
  assert.equal(recoveredReady.revisionBasePhase, undefined);

  const firstPlan = planningFailed({ ...emptyPlanState(), phase: 'planning' as const }, 'planner failed');
  assert.equal(firstPlan.phase, 'idle');
  assert.equal(firstPlan.current, undefined);
  assert.equal(firstPlan.error, 'planner failed');
});

test('build prompts retain optional plan headings, overview, and task details', () => {
  const prompt = buildPrompt({
    ...current,
    name: 'Safe restore', overview: 'Preserve the previous workspace state.',
    todos: [{ content: 'Verify files', status: 'pending' }],
  });
  assert.match(prompt, /# Safe restore/);
  assert.match(prompt, /Preserve the previous workspace state\./);
  assert.match(prompt, /- \[pending\] Verify files/);
  assert.ok(prompt.indexOf('# Safe restore') < prompt.indexOf('Preserve the previous workspace state.'));
  assert.ok(prompt.indexOf('Preserve the previous workspace state.') < prompt.indexOf('Keep this plan'));
});
