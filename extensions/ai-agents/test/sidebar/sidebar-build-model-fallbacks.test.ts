import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function installReadyPlan(harness: Harness, id: string): void {
  const state = harness.sidebar.controller.snapshot();
  state.plan = {
    phase: 'ready',
    revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: '# Round 16' }],
    current: { id, revision: 1, markdown: '# Round 16', todos: [], source: 'assistant-text', createdAt: 1 },
    build: { selection: { ...state.selection, model: 'saved-build-model' }, label: 'Saved build model' },
  };
  harness.sidebar.controller.restoreSnapshot(state);
}

test('build model without an ID is rejected, and a blank Build label falls back to the model ID', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    let catalogCalls = 0;
    harness.sidebar.listAvailableModels = async () => { catalogCalls += 1; return [{ id: 'round16-build-model', label: '' }]; };
    installReadyPlan(harness, 'round16-model-plan');
    const originalBuild = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await assert.rejects(harness.sidebar.handleMessage({ type: 'setBuildModel' }), /モデル一覧に、そのモデルはありません/);
    assert.equal(catalogCalls, 1);
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, originalBuild);

    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: { model: string }): Promise<void>;
    };
    controller.build = async (_planId, _revision, selection) => {
      const state = harness.sidebar.controller.snapshot();
      state.selection = { ...state.selection, model: selection.model };
      state.plan.phase = 'implemented';
      harness.sidebar.controller.restoreSnapshot(state);
    };
    await harness.sidebar.handleMessage({
      type: 'buildPlan', planId: 'round16-model-plan', revision: 1, modelId: 'round16-build-model', label: '', modelParams: [],
    });

    const selected = harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(selected, { model: 'round16-build-model', label: 'round16-build-model', hasDetails: false });
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'implemented');
  } finally {
    await close(harness);
  }
});

test('setBuildParam with no id is a no-op on the saved Build selection', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    installReadyPlan(harness, 'round16-param-plan');
    const saved = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await harness.sidebar.handleMessage({ type: 'setBuildParam', value: 'high' });

    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, saved);
    assert.equal(harness.sidebar.controller.snapshot().plan.current?.id, 'round16-param-plan');
  } finally {
    await close(harness);
  }
});
