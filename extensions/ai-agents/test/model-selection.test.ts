import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseModelLabel, matchesModel, selectBaseModel } from '../src/model-selection.js';
import type { AgentModel, Selection } from '../src/types.js';

const model: AgentModel = { id: 'fixture-model', label: 'Fixture Model', aliases: ['fixture-alias'],
  defaultParams: [{ id: 'effort', value: 'medium' }, { id: 'context', value: '200k' }] };
const current: Selection = { provider: 'cursor', cwd: '/workspace', model: model.id,
  modelParams: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }] };

test('reselecting a base model preserves effort/context settings and the session identity', () => {
  assert.deepEqual(selectBaseModel(model, current), current);
  const implicit = { ...current, modelParams: undefined };
  assert.equal(selectBaseModel(model, implicit).modelParams, undefined);
});

test('a previously saved alias is recognized without replacing its detailed settings', () => {
  const aliased = { ...current, model: 'fixture-alias' };
  assert.equal(matchesModel(model, aliased.model), true);
  assert.deepEqual(selectBaseModel(model, aliased), aliased);
});

test('switching base models uses the new defaults without carrying incompatible details', () => {
  const selected = selectBaseModel({ ...model, id: 'other-model', aliases: [] }, current);
  assert.equal(selected.model, 'other-model');
  assert.deepEqual(selected.modelParams, model.defaultParams);
  assert.equal(selectBaseModel({ id: '', label: '既定のモデル' }, current).modelParams, undefined);
});

test('old variant labels are reduced to the base label without renaming real model tiers', () => {
  assert.equal(baseModelLabel('Fixture Model — High 1M Fast'), 'Fixture Model');
  assert.equal(baseModelLabel('Fixture Mini'), 'Fixture Mini');
});
