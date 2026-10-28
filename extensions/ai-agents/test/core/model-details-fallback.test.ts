
import assert from 'node:assert/strict';

import { mock, test } from 'node:test';

import { ModelDetails } from '../../src/model-details.js';

import { commands, ExtensionContext, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { settle } from '../support/vscode-harness.js';

test('model details show an SDK default that is missing from its advertised values', async () => {
  resetVscode();
  const inconsistent = {
    id: 'gpt-edge', label: 'Edge model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
    defaultParams: [{ id: 'effort', value: 'future-value' }],
  };
  const details = new ModelDetails();
  const pending = details.edit({ provider: 'cursor', cwd: '/work', model: 'gpt-edge' }, async () => inconsistent);
  const picker = window.quickPicks.at(-1) as unknown as {
    items: Array<{ id: string; description?: string }>;
    selectedItems: object[];
    activeItems: Array<{ id: string }>;
    accept(): void;
    hide(): void;
  } | undefined;
  assert.ok(picker);
  await settle();
  const parameterItem = picker.items.find((item) => item.id === 'parameter:effort') as { description?: string } | undefined;
  assert.equal(parameterItem?.description, 'future-value');
  picker.selectedItems = [parameterItem as object];
  picker.accept();
  assert.equal(picker.activeItems[0]?.id, 'default:effort');
  picker.hide();
  assert.equal(await pending, undefined);
});;
