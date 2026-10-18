import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model details does not overwrite a concurrent parameter change made through the settings route', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-race-model', label: 'Details race model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    const editing = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'model details catalog');
    const picker = window.quickPicks.at(-1)!;
    const effort = picker.items.find((item) => (item as { id?: string }).id === 'parameter:effort');
    assert.ok(effort);
    picker.selectedItems = [effort];
    picker.accept();
    const low = picker.items.find((item) => (item as { id?: string }).id === 'value:effort:low');
    assert.ok(low);
    picker.selectedItems = [low];
    picker.accept();

    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    const apply = picker.items.find((item) => (item as { action?: string }).action === 'apply');
    assert.ok(apply);
    picker.selectedItems = [apply];
    picker.accept();
    await editing;

    assert.deepEqual(harness.sidebar.controller.snapshot().selection, {
      provider: 'codex', cwd: harness.workspacePath, model: model.id, modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex?.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
