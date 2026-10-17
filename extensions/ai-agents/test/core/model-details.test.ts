import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelDetails } from '../../src/model-details.js';
import type { AgentModel, ModelParameter, Selection } from '../../src/types.js';
import { QuickPick, resetVscode, window } from '../support/vscode-stub.js';
import { settle } from '../support/vscode-harness.js';

const parameter: ModelParameter = {
  id: 'effort',
  label: 'Effort',
  values: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High', description: 'larger' },
  ],
};
const model: AgentModel = {
  id: 'gpt-test',
  label: 'GPT Test',
  parameters: [parameter, { id: 'empty', label: 'Empty', values: [] }],
  defaultParams: [{ id: 'effort', value: 'low' }],
};
const selection: Selection = { provider: 'cursor', cwd: '/work', model: 'gpt-test', modelParams: [{ id: 'effort', value: 'low' }] };

interface DetailItem {
  id: string;
  action: string;
  label: string;
  value?: string;
  parameter?: ModelParameter;
}

function picker(): QuickPick<DetailItem> {
  const created = window.quickPicks.at(-1);
  assert.ok(created);
  return created as QuickPick<DetailItem>;
}

test('accepting a value and apply returns the edited params', async () => {
  resetVscode();
  const details = new ModelDetails();
  const pending = details.edit(selection, async () => model);
  const input = picker();
  await settle();
  assert.equal(input.busy, false);
  assert.equal(input.items.some((item) => item.id === 'parameter:empty'), false);
  assert.equal(details.isReady(), false);
  const parameterItem = input.items.find((item) => item.id === 'parameter:effort');
  assert.ok(parameterItem);
  input.selectedItems = [parameterItem];
  input.activate([parameterItem]);
  assert.equal(details.isReady('parameter:effort'), true);
  input.accept();
  const high = input.items.find((item) => item.id === 'value:effort:high');
  assert.ok(high);
  input.selectedItems = [high];
  input.accept();
  input.triggerButton();
  assert.equal(input.items.some((item) => item.action === 'apply'), true);
  input.activate([input.items.find((item) => item.id === 'parameter:effort')!]);
  input.selectedItems = [input.items.find((item) => item.id === 'parameter:effort')!];
  input.accept();
  const useDefault = input.items.find((item) => item.id === 'default:effort');
  assert.ok(useDefault);
  input.selectedItems = [useDefault];
  input.accept();
  const reset = input.items.find((item) => item.action === 'reset');
  assert.ok(reset);
  input.selectedItems = [reset];
  input.accept();
  const apply = input.items.find((item) => item.action === 'apply');
  assert.ok(apply);
  input.selectedItems = [apply];
  input.accept();
  assert.deepEqual(await pending, [{ id: 'effort', value: 'low' }]);
  assert.equal(input.disposed, true);
});

test('choosing a non-default value is what apply resolves', async () => {
  resetVscode();
  const details = new ModelDetails();
  const pending = details.edit(selection, async () => model);
  const input = picker();
  await settle();
  const parameterItem = input.items.find((item) => item.action === 'parameter');
  assert.ok(parameterItem);
  input.selectedItems = [parameterItem];
  input.accept();
  const high = input.items.find((item) => item.value === 'high');
  assert.ok(high);
  input.selectedItems = [high];
  input.accept();
  const apply = input.items.find((item) => item.action === 'apply');
  assert.ok(apply);
  input.selectedItems = [apply];
  input.accept();
  assert.deepEqual(await pending, [{ id: 'effort', value: 'high' }]);
  assert.equal(window.informationMessages.length, 0);
});

test('hiding the picker cancels, including when loading fails afterwards', async () => {
  resetVscode();
  const details = new ModelDetails();
  const pending = details.edit(selection, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error('late failure');
  });
  picker().hide();
  assert.equal(await pending, undefined);
  details.show();
  details.hide();
});

test('a model that resolves after the picker closes is ignored', async () => {
  resetVscode();
  let release!: (value: AgentModel) => void;
  const pending = new ModelDetails().edit(selection, () => new Promise<AgentModel>((resolve) => { release = resolve; }));
  const input = picker();
  input.hide();
  release(model);
  assert.equal(await pending, undefined);
  assert.equal(input.items.length, 0, 'late model results do not repopulate a hidden picker');
});

test('a missing model, a model without parameters, and a load error are reported', async () => {
  resetVscode();
  await assert.rejects(new ModelDetails().edit(selection, async () => undefined), /モデル一覧から、詳細設定を変更するモデルを選択してください/);
  resetVscode();
  const empty = new ModelDetails().edit(selection, async () => ({ id: 'plain', label: 'Plain' }));
  assert.equal(await empty, undefined);
  assert.match(window.informationMessages[0] ?? '', /Plain/);
  for (const parameters of [[], [{ id: 'hidden', label: 'Hidden', values: [] }]]) {
    resetVscode();
    const noChoices = await new ModelDetails().edit(selection, async () => ({ id: 'no-choices', label: 'No choices', parameters }));
    assert.equal(noChoices, undefined);
    assert.match(window.informationMessages[0] ?? '', /No choices/);
  }
  resetVscode();
  await assert.rejects(new ModelDetails().edit(selection, async () => { throw new Error('list down'); }), /list down/);
});

test('accept is ignored while the list is loading or when nothing is selected, and invalid values throw', async () => {
  resetVscode();
  let release: (model: AgentModel) => void = () => {};
  const details = new ModelDetails();
  const pending = details.edit(selection, () => new Promise<AgentModel>((resolve) => { release = resolve; }));
  const input = picker();
  assert.equal(input.busy, true);
  input.accept();
  input.triggerButton();
  input.activate([]);
  assert.equal(details.isReady(), false);
  release(model);
  await settle();
  input.selectedItems = [];
  input.accept();
  input.selectedItems = [{ id: 'bad', action: 'value', label: 'nope', parameter, value: 'nope' }];
  assert.throws(() => input.accept(), /選択できない設定値です/);
  input.hide();
  assert.equal(await pending, undefined);
});

test('Codex reset clears effort instead of restoring an SDK default', async () => {
  resetVscode();
  const codex: Selection = { provider: 'codex', cwd: '/work', model: 'gpt-test' };
  const pending = new ModelDetails().edit(codex, async () => model);
  const input = picker();
  await settle();
  const parameterItem = input.items.find((item) => item.action === 'parameter');
  assert.ok(parameterItem);
  input.selectedItems = [parameterItem];
  input.accept();
  const high = input.items.find((item) => item.value === 'high');
  assert.ok(high);
  input.selectedItems = [high];
  input.accept();
  const reset = input.items.find((item) => item.action === 'reset');
  assert.ok(reset);
  input.selectedItems = [reset];
  input.accept();
  const apply = input.items.find((item) => item.action === 'apply');
  assert.ok(apply);
  input.selectedItems = [apply];
  input.accept();
  assert.deepEqual(await pending, []);
});
