import assert from 'node:assert/strict';

import { test } from 'node:test';

import { baseModelLabel, selectBaseModel } from '../../src/model-selection.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

test('model selection omits empty params and keeps an alias identity', () => {
  const current: Selection = { provider: 'cursor', cwd: '/work', model: 'alias', modelParams: [{ id: 'effort', value: 'high' }] };
  const same = selectBaseModel({ id: 'base', label: 'Base', aliases: ['alias'], parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'high', label: 'High' }] }] }, current);
  assert.equal(same.model, 'alias');
  assert.equal(same.modelParams?.[0]?.value, 'high');
  const switched = selectBaseModel({ id: 'other', label: 'Other' }, current);
  assert.equal(switched.model, 'other');
  assert.equal(switched.modelParams, undefined);
  assert.equal(baseModelLabel('Model — High 1M'), 'Model');
  assert.equal(baseModelLabel('Model'), 'Model');
  assert.equal(baseModelLabel(' — High'), ' — High');
  assert.equal(baseModelLabel(''), '');
});;
