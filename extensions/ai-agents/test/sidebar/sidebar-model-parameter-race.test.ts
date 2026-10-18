import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a slower model parameter lookup cannot overwrite a newer value in the same conversation', async () => {
  resetVscode();
  const model: AgentModel = {
    id: 'raced-model', label: 'Raced model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  const harness = openSidebar(() => { workspace.configuration['ai-agents']!['codex.model'] = model.id; });
  const firstLookupStarted = deferred<void>();
  const firstLookup = deferred<AgentModel[]>();
  let lookups = 0;
  harness.sidebar.listAvailableModels = async () => {
    lookups += 1;
    if (lookups === 1) {
      firstLookupStarted.resolve();
      return firstLookup.promise;
    }
    return [model];
  };
  try {
    const staleLow = harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'low' });
    await firstLookupStarted.promise;
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);

    firstLookup.resolve([model]);
    await staleLow;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex?.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    firstLookup.resolve([]);
    await close(harness);
  }
});
