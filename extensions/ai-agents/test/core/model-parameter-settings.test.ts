import assert from 'node:assert/strict';

import { test } from 'node:test';

import { annotateParameter, catalogIsCurrent, filterModels, formatToken, isToggleOn, orderedParameters, parameterRole, reconcileModelParams, toCatalogModel, toggleOnValue } from '../../src/model-settings.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

test('model settings order toggles, reconcile fallbacks, and catalog fields', () => {
  const fast = { id: 'fast', label: 'fast', values: [{ value: 'off', label: 'off' }, { value: 'YES', label: 'YES' }] };
  const effort = { id: 'reasoning_effort', label: 'reasoning_effort', values: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }] };
  const context = { id: 'context_size', label: 'Window', values: [{ value: '1.5k', label: '1.5k' }] };
  const ordered = orderedParameters([effort, fast, context]);
  assert.deepEqual(ordered.map((item) => item.id), ['fast', 'reasoning_effort']);
  assert.equal(ordered[0]?.presentation, 'toggle');
  assert.equal(parameterRole('modelReasoningEffort'), 'effort');
  assert.equal(parameterRole('context'), 'context');
  assert.equal(parameterRole('fast'), 'fast');
  assert.equal(parameterRole('temperature'), 'other');
  assert.equal(formatToken('2m'), '2M');
  assert.equal(isToggleOn(undefined), false);
  assert.equal(isToggleOn('YES'), true);
  assert.equal(isToggleOn('no'), false);
  assert.equal(toggleOnValue([{ value: 'off' }, { value: 'YES' }]), 'YES');
  assert.equal(toggleOnValue([{ value: 'off' }]), undefined);
  assert.equal(annotateParameter({ id: 'solo', label: 'Solo', values: [{ value: 'only', label: 'only' }] }), undefined);
  const model: AgentModel = {
    id: 'm', label: 'M', description: 'desc', aliases: ['alias'], isDefault: true,
    parameters: [effort, fast],
    defaultParams: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'YES' }],
  };
  const catalog = toCatalogModel(model);
  assert.equal(catalog.description, 'desc');
  assert.deepEqual(catalog.aliases, ['alias']);
  assert.equal(catalog.isDefault, true);
  assert.equal(toCatalogModel({ id: 'bare', label: 'Bare' }).description, undefined);
  assert.equal(reconcileModelParams({ id: '', label: '' }, [], 'codex'), undefined);
  assert.equal(reconcileModelParams({ id: 'bare', label: 'Bare' }, undefined, 'codex'), undefined);
  assert.deepEqual(reconcileModelParams({ id: 'bare', label: 'Bare', defaultParams: [{ id: 'effort', value: 'low' }] }, undefined, 'cursor'), [{ id: 'effort', value: 'low' }]);
  const cursor = reconcileModelParams(model, [{ id: 'reasoning_effort', value: 'nope' }], 'cursor');
  assert.equal(cursor?.find((item) => item.id === 'reasoning_effort')?.value, 'high');
  assert.equal(cursor?.find((item) => item.id === 'fast')?.value, 'YES');
  const codex = reconcileModelParams(model, [{ id: 'fast', value: 'off' }], 'codex');
  assert.equal(codex?.find((item) => item.id === 'fast')?.value, 'off');
  assert.equal(codex?.some((item) => item.id === 'reasoning_effort'), false);
  const invalidFallback = reconcileModelParams({ ...model, defaultParams: [{ id: 'reasoning_effort', value: 'missing' }] }, [{ id: 'reasoning_effort', value: 'nope' }], 'cursor');
  assert.equal(invalidFallback?.some((item) => item.id === 'reasoning_effort') ?? false, false);
  assert.deepEqual(filterModels([model], ''), [model]);
  assert.equal(filterModels([model], 'DESC').length, 1);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'codex', cwd: '/b' }), false);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'cursor', cwd: '/a' }), false);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'codex', cwd: '/a' }), true);
  const tied = reconcileModelParams({
    id: 'm', label: 'M',
    parameters: [
      { id: 'zeta', label: 'Zeta', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
      { id: 'alpha', label: 'Alpha', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
    ],
  }, [{ id: 'zeta', value: 'low' }, { id: 'alpha', value: 'high' }], 'codex');
  assert.deepEqual(tied?.map((item) => item.id), ['alpha', 'zeta']);
});;
