import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateParameter, catalogIsCurrent, displayValueLabel, filterModels, ModelSettingsDraft, orderedParameters, parameterPresentation, sameModelParams } from '../../src/model-settings.js';
import { modelApplyMode } from '../../src/capabilities.js';
import type { AgentModel, ModelParameter } from '../../src/types.js';

const model: AgentModel = {
  id: 'fixture', label: 'Fixture',
  parameters: [
    { id: 'effort', label: 'Effort', defaultValue: 'high', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
    { id: 'context', label: 'Context size', defaultValue: '1m', values: [{ value: '200k', label: '200K' }, { value: '1m', label: '1M' }] },
  ],
  defaultParams: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }],
};

test('Cursor detail edits preserve other fields and reset to the SDK defaults', () => {
  const draft = new ModelSettingsDraft(model, 'cursor', [{ id: 'context', value: '200k' }]);
  assert.equal(draft.value('effort'), 'high');
  assert.equal(draft.value('context'), '200k');
  draft.set(model.parameters![0]!, 'low');
  assert.equal(draft.value('context'), '200k');
  draft.set(model.parameters![0]!, undefined);
  assert.equal(draft.value('effort'), 'high');
  draft.reset();
  assert.deepEqual(draft.params(), model.defaultParams);
});

test('Codex default/reset leaves the effort unspecified so existing Codex settings apply', () => {
  const draft = new ModelSettingsDraft(model, 'codex');
  assert.deepEqual(draft.params(), []);
  draft.set(model.parameters![0]!, 'low');
  assert.deepEqual(draft.params(), [{ id: 'effort', value: 'low' }]);
  draft.set(model.parameters![0]!, undefined);
  assert.deepEqual(draft.params(), []);
  draft.set(model.parameters![0]!, 'high');
  draft.reset();
  assert.deepEqual(draft.params(), []);
});

test('unsupported values cannot be selected or restored into the detail draft', () => {
  const draft = new ModelSettingsDraft(model, 'cursor', [{ id: 'effort', value: 'invalid' }]);
  assert.equal(draft.value('effort'), 'high');
  assert.throws(() => draft.set(model.parameters![0]!, 'invalid'), /選択できない/);
});

test('display labels, search, and backend support do not invent unavailable settings', () => {
  assert.equal(displayValueLabel('xhigh'), 'Extra High');
  assert.equal(displayValueLabel('200k'), '200K');
  assert.equal(displayValueLabel('high', 'Max reasoning'), 'Max reasoning');
  assert.equal(displayValueLabel('custom-token'), 'custom-token');
  assert.deepEqual(filterModels([
    { id: 'grok-4.7', label: 'Grok 4.7', aliases: ['grok'] },
    { id: 'gpt', label: 'GPT-6.1 Sol' },
  ], 'GROK').map((model) => model.id), ['grok-4.7']);
  assert.deepEqual(filterModels([{ id: 'gpt', label: 'GPT', aliases: ['sol'] }], 'missing'), []);
  assert.equal(parameterPresentation({ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }), 'toggle');
  assert.equal(parameterPresentation({ id: 'context', values: [{ value: '256k' }, { value: '500k' }] }), 'menu');
  assert.equal(parameterPresentation({ id: 'effort', values: [] }), 'hidden');
  assert.equal(catalogIsCurrent({ requestId: 2, provider: 'cursor', cwd: '/work' }, { requestId: 1, provider: 'cursor', cwd: '/work' }), false);
  assert.equal(modelApplyMode('cursor', 'acp'), 'next-send');
  assert.equal(modelApplyMode('cursor', 'cli'), 'next-send');
  assert.equal(modelApplyMode('codex', 'app-server'), 'next-send');
  assert.equal(modelApplyMode('codex', 'cli'), 'next-send');
  const custom = annotateParameter({ id: 'custom-setting', label: '', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  assert.equal(custom?.label, 'custom-setting', 'an unlabeled custom parameter uses its stable id as the display title');
  assert.equal(custom?.role, 'other');
});

test('parameter order does not create a configuration change', () => {
  assert.ok(sameModelParams(model.defaultParams, [...model.defaultParams!].reverse()));
  assert.ok(sameModelParams(undefined, []));
  assert.equal(sameModelParams(model.defaultParams, [{ id: 'effort', value: 'low' }]), false);
});

test('Cursor parameters without SDK defaults use the declared fallback then clear it when absent', () => {
  const parameter: ModelParameter = {
    id: 'effort', label: 'effort', defaultValue: 'high', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  };
  const draft = new ModelSettingsDraft({ id: 'no-sdk-default', label: 'Fixture', parameters: [parameter] }, 'cursor');
  assert.deepEqual(draft.params(), []);
  draft.set(parameter, undefined);
  assert.deepEqual(draft.params(), [{ id: 'effort', value: 'high' }]);
  draft.set({ ...parameter, defaultValue: undefined }, undefined);
  assert.deepEqual(draft.params(), []);
});

test('parameter labels use role names and stable ordering when role ranks tie', () => {
  for (const [id, label] of [['effort', 'Effort'], ['context_size', 'Context'], ['fast', 'Fast']] as const) {
    const annotated = annotateParameter({ id, label: id, values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
    assert.equal(annotated?.label, label);
  }
  const ordered = orderedParameters([
    { id: 'zeta', label: 'Zeta', role: 'other', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { id: 'alpha', label: 'Alpha', role: 'other', values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['zeta', 'alpha'], 'equal role ranks retain the catalog order');
  const preannotated = orderedParameters([
    { id: 'first', label: 'First', presentation: 'menu', values: [{ value: 'a', label: 'A' }] },
    { id: 'second', label: 'Second', presentation: 'menu', values: [{ value: 'a', label: 'A' }] },
  ]);
  assert.deepEqual(preannotated.map((item) => item.id), ['first', 'second'], 'preannotated parameters without role metadata use the other rank and preserve order');
});
