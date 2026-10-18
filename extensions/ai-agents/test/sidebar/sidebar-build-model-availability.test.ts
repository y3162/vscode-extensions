import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('empty Build model IDs fail without changing the plan, and ACP ignores unsupported model changes', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    let catalogCalls = 0;
    harness.sidebar.listAvailableModels = async () => {
      catalogCalls += 1;
      return [{ id: 'cursor-build-model', label: 'Cursor build model' }];
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: '# Ready' }],
      current: { id: 'round11-build', revision: 1, markdown: '# Ready', todos: [], source: 'assistant-text', createdAt: 1 },
      build: { selection: { ...state.selection, model: 'saved-build-model' }, label: 'Saved build model' },
    };
    harness.sidebar.controller.restoreSnapshot(state);
    const savedBuild = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: '' }),
      /モデル一覧に、そのモデルはありません/,
    );
    assert.equal(catalogCalls, 1, 'an empty ID is treated as no matching catalog choice');
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, savedBuild);

    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'acp' });
    const cursorState = harness.sidebar.controller.snapshot();
    cursorState.plan.phase = 'ready';
    cursorState.plan.current = { id: 'round11-cursor-build', revision: 2, markdown: '# Cursor', todos: [], source: 'assistant-text', createdAt: 2 };
    cursorState.plan.revisions = [{ revision: 2, createdAt: 2, source: 'assistant-text', markdown: '# Cursor' }];
    cursorState.plan.build = { selection: { ...cursorState.selection, model: 'cursor-build-model' }, label: 'Cursor build model' };
    harness.sidebar.controller.restoreSnapshot(cursorState);
    await harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'cursor-build-model' });

    assert.equal(catalogCalls, 2, 'ACP Build selection reads the model catalog');
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.selection.model, 'cursor-build-model');
  } finally {
    await close(harness);
  }
});
