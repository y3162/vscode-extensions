import assert from 'node:assert/strict';

import { mkdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel } from '../../src/types.js';

import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { openSidebar, waitFor } from '../support/vscode-harness.js';

async function close(harness: ReturnType<typeof openSidebar>): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model picker persists that a selected catalog model has editable details', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'round14-detailed-picker-model',
    label: 'Detailed picker model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    const choosing = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'detailed model picker catalog');
    const picker = window.quickPicks.at(-1);
    assert.ok(picker);
    assert.equal(picker.items.length, 1);
    picker.selectedItems = [picker.items[0]!];
    picker.accept();
    await choosing;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.deepEqual(
      harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex,
      { model: model.id, label: model.label, hasDetails: true },
      'the persisted model choice advertises its available detail settings',
    );
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
