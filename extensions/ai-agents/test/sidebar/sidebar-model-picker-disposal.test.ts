import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('disposing a Sidebar aborts an in-flight model picker request and closes its picker', async () => {
  resetVscode();
  const harness = openSidebar();
  const entered = deferred<AbortSignal>();
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    entered.resolve(signal!);
    return new Promise<AgentModel[]>(() => {});
  };
  const select = harness.sidebar.selectModel();
  let signal!: AbortSignal;
  try {
    signal = await entered.promise;
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.busy, true);
    await harness.sidebar.dispose();
    await select;

    assert.equal(signal.aborted, true);
    assert.equal(picker.shown, false);
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('disposing a Sidebar aborts a model-details load without applying a partial selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-dispose-model', label: 'Details model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  const selection: Selection = { provider: 'codex', cwd: harness.workspacePath, model: model.id };
  const entered = deferred<AbortSignal>();
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    entered.resolve(signal!);
    return new Promise<AgentModel[]>(() => {});
  };
  await harness.sidebar.controller.select(selection);
  const editing = harness.sidebar.configureModel();
  try {
    const signal = await entered.promise;
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.busy, true);
    await harness.sidebar.dispose();
    await editing;

    assert.equal(signal.aborted, true);
    assert.equal(picker.shown, false);
    assert.equal(picker.disposed, true);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selection);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex, undefined);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
