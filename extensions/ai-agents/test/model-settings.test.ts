import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelSettingsDraft, sameModelParams } from '../src/model-settings.js';
import type { AgentModel } from '../src/types.js';

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

test('parameter order does not create a configuration change', () => {
  assert.ok(sameModelParams(model.defaultParams, [...model.defaultParams!].reverse()));
  assert.ok(sameModelParams(undefined, []));
  assert.equal(sameModelParams(model.defaultParams, [{ id: 'effort', value: 'low' }]), false);
});
