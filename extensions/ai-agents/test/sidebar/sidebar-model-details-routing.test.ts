import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import { commands, resetVscode, Uri, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model details reuses an open model picker instead of creating a competing picker', async () => {
  resetVscode();
  const harness = openSidebar();
  harness.sidebar.listAvailableModels = async () => [{ id: 'round11-picker', label: 'Picker model' }];
  try {
    const picking = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'model picker catalog');
    const picker = window.quickPicks.at(-1)!;

    await harness.sidebar.handleMessage({ type: 'modelDetails' });

    assert.equal(window.quickPicks.length, 1);
    assert.equal(picker.shown, true);
    assert.equal(picker.disposed, false);
    picker.hide();
    await picking;
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
  } finally {
    await close(harness);
  }
});

test('details resolve a saved model alias and reset its Codex parameter to the unspecified default', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'round11-canonical-model', label: 'Canonical settings model', aliases: ['round11-short-name'],
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  await harness.sidebar.controller.select({
    provider: 'codex', cwd: harness.workspacePath, model: 'round11-short-name', modelParams: [{ id: 'effort', value: 'high' }],
  });
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    const editing = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'aliased model details');
    const picker = window.quickPicks.at(-1)!;
    const reset = picker.items.find((item) => (item as { action?: string }).action === 'reset');
    assert.ok(reset);
    picker.selectedItems = [reset];
    picker.accept();

    const apply = picker.items.find((item) => (item as { action?: string }).action === 'apply');
    assert.ok(apply);
    picker.selectedItems = [apply];
    picker.accept();
    await editing;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round11-short-name');
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex, {
      model: 'round11-short-name', label: 'Canonical settings model', hasDetails: true,
    });
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
