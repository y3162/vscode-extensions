import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { env, resetVscode, window } from '../support/vscode-stub.js';

import { openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Japanese Build fallback persists the localized placeholder when label and model ID are empty', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = openSidebar();
  try {
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: '# Empty model' }],
      current: { id: 'round17-empty-model-plan', revision: 1, markdown: '# Empty model', todos: [], source: 'assistant-text', createdAt: 1 },
      build: { selection: { ...state.selection, model: '' }, label: '' },
    };
    harness.sidebar.controller.restoreSnapshot(state);

    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: { model: string; modelParams?: Array<{ id: string; value: string }> }): Promise<void>;
    };
    controller.build = async (_planId, _revision, selection) => {
      const next = harness.sidebar.controller.snapshot();
      next.selection = { ...next.selection, model: selection.model, modelParams: selection.modelParams };
      next.plan.phase = 'implemented';
      harness.sidebar.controller.restoreSnapshot(next);
    };

    await harness.sidebar.handleMessage({
      type: 'buildPlan', planId: 'round17-empty-model-plan', revision: 1, modelId: '', label: '', modelParams: [],
    });

    const selected = harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(selected, { model: '', label: 'モデルを選択', hasDetails: false });
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'implemented', 'the empty model selection is persisted only after Build acknowledges it');
  } finally {
    await close(harness);
  }
});
