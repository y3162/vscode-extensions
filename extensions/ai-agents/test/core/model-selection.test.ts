import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseModelLabel, matchesModel, selectBaseModel } from '../../src/model-selection.js';
import type { AgentModel, Selection } from '../../src/types.js';

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

test('switching models keeps a supported effort and drops values the new model cannot use', () => {
  const nextModel: AgentModel = {
    id: 'other-model', label: 'Other',
    parameters: [
      { id: 'effort', label: 'Effort', role: 'effort', presentation: 'menu', defaultValue: 'medium', values: [
        { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' },
      ] },
      { id: 'context', label: 'Context', role: 'context', presentation: 'menu', defaultValue: '200k', values: [
        { value: '200k', label: '200K' },
      ] },
      { id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [
        { value: 'false', label: 'false' }, { value: 'true', label: 'true' },
      ] },
    ],
    defaultParams: [
      { id: 'effort', value: 'medium' }, { id: 'context', value: '200k' }, { id: 'fast', value: 'false' },
    ],
  };
  assert.deepEqual(selectBaseModel(nextModel, current).modelParams, [
    { id: 'fast', value: 'false' }, { id: 'context', value: '200k' }, { id: 'effort', value: 'high' },
  ]);
  const codex = selectBaseModel({
    id: 'codex-b', label: 'Codex B',
    parameters: [{ id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu', defaultValue: 'medium', values: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
    ] }],
  }, { provider: 'codex', cwd: '/workspace', model: 'codex-a', modelParams: [
    { id: 'modelReasoningEffort', value: 'xhigh' }, { id: 'fast', value: 'true' },
  ] });
  assert.deepEqual(codex.modelParams, [{ id: 'modelReasoningEffort', value: 'medium' }]);
  const omitted = selectBaseModel({
    id: 'codex-b', label: 'Codex B',
    parameters: [{ id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu', values: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
    ] }],
  }, { provider: 'codex', cwd: '/workspace', model: 'codex-a', modelParams: undefined });
  assert.equal(omitted.modelParams, undefined);
});

test('old variant labels are reduced to the base label without renaming real model tiers', () => {
  assert.equal(baseModelLabel('Fixture Model — High 1M Fast'), 'Fixture Model');
  assert.equal(baseModelLabel('Fixture Mini'), 'Fixture Mini');
});
