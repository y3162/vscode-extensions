import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Sidebar model details apply persists the selected parameter with the model label', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-model', label: 'Details Model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  try {
    await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
    harness.sidebar.listAvailableModels = async () => [model];
    const editing = harness.sidebar.configureModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'loaded model details');
    const picker = window.quickPicks.at(-1)!;
    const parameter = picker.items.find((item) => (item as { action?: string; id?: string }).id === 'parameter:effort');
    assert.ok(parameter);
    picker.selectedItems = [parameter];
    picker.accept();
    const high = picker.items.find((item) => (item as { id?: string }).id === 'value:effort:high');
    assert.ok(high);
    picker.selectedItems = [high];
    picker.accept();
    const apply = picker.items.find((item) => (item as { action?: string }).action === 'apply');
    assert.ok(apply);
    picker.selectedItems = [apply];
    picker.accept();
    await editing;

    assert.deepEqual(harness.sidebar.controller.snapshot().selection, {
      provider: 'codex', cwd: harness.workspacePath, model: model.id, modelParams: [{ id: 'effort', value: 'high' }],
    } satisfies Selection);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; modelParams?: { id: string; value: string }[] }>>('ai-agents.selectedModels')?.codex, {
      model: model.id, label: model.label, hasDetails: true, modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
