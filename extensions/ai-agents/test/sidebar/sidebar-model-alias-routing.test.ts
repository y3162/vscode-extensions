import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection, SessionSummary } from '../../src/types.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model aliases resolve through one cached catalog and preserve the canonical model label', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'canonical-model', label: 'Canonical model', aliases: ['short-alias'],
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  let lookups = 0;
  harness.sidebar.listAvailableModels = async () => { lookups += 1; return [model]; };
  try {
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 51, refresh: true });
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'short-alias' });
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'short-alias' });

    assert.equal(lookups, 1, 'selection reuses the catalog returned by the explicit refresh');
    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.model, model.id);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.label, model.label);

    const before = harness.sidebar.controller.snapshot().selection;
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'unknown-value' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, before);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
