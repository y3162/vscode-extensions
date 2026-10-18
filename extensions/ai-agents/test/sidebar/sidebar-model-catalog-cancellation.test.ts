import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model picker cancellation aborts pending discovery and ignores both late success and late failure', async () => {
  resetVscode();
  const harness = openSidebar();
  let rejectFirst!: (error: Error) => void;
  let resolveSecond!: (models: AgentModel[]) => void;
  let firstSignal: AbortSignal | undefined;
  let secondSignal: AbortSignal | undefined;
  let calls = 0;
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    calls += 1;
    if (calls === 1) {
      firstSignal = signal;
      return new Promise<AgentModel[]>((_resolve, reject) => { rejectFirst = reject; });
    }
    secondSignal = signal;
    return new Promise<AgentModel[]>((resolve) => { resolveSecond = resolve; });
  };
  const original = harness.sidebar.controller.snapshot().selection;
  try {
    const first = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.length === 1, 'first picker');
    const firstPicker = window.quickPicks[0]!;
    await harness.sidebar.selectModel();
    assert.equal(window.quickPicks.length, 1, 'reopening an active picker must not create a second picker');
    firstPicker.hide();
    await first;
    assert.equal(firstSignal?.aborted, true);
    assert.equal(firstPicker.disposed, true);
    rejectFirst(new Error('late catalog failure'));
    await settle();
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, original);
    assert.equal(window.errorMessages.some((message) => message.includes('late catalog failure')), false);

    const second = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.length === 2, 'second picker');
    const secondPicker = window.quickPicks[1]!;
    secondPicker.hide();
    await second;
    assert.equal(secondSignal?.aborted, true);
    resolveSecond([{ id: 'late-model', label: 'Late model' }]);
    await settle();
    assert.equal(secondPicker.disposed, true);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, original);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
  } finally {
    await close(harness);
  }
});

test('an empty Cursor catalog leaves the picker usable and a changed provider cannot accept its stale item', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.listAvailableModels = async () => [];
    const empty = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'empty Cursor catalog');
    const emptyPicker = window.quickPicks.at(-1)!;
    assert.match(emptyPicker.title, /Cursor/);
    assert.match(emptyPicker.placeholder, /モデルが見つかりません/);
    assert.deepEqual(emptyPicker.activeItems, []);
    assert.equal(harness.sidebar.isModelPickerReady(), false);
    emptyPicker.hide();
    await empty;
    assert.equal(emptyPicker.disposed, true);

    const staleModel: AgentModel = { id: 'stale-picker-model', label: 'Stale picker model' };
    harness.sidebar.listAvailableModels = async () => [staleModel];
    const choosing = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'stale picker catalog');
    const picker = window.quickPicks.at(-1)!;
    picker.selectedItems = [picker.items[0]!];
    await harness.sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: harness.workspacePath });
    picker.accept();
    await choosing;

    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'codex');
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
