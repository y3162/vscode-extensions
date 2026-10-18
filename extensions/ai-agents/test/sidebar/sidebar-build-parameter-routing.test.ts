import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import { resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function restoreReadyPlan(sidebar: AgentsSidebar, id: string, revision: number): void {
  const state = sidebar.controller.snapshot();
  state.plan = {
    phase: 'ready',
    revisions: [{ revision, createdAt: revision, source: 'assistant-text', markdown: `# Plan ${revision}` }],
    current: { id, revision, markdown: `# Plan ${revision}`, todos: [], source: 'assistant-text', createdAt: revision },
  };
  sidebar.controller.restoreSnapshot(state);
}

test('Build parameters replace by id, preserve other settings, and reject an unknown Build model safely', async () => {
  resetVscode();
  const harness = openSidebar();
  harness.sidebar.listAvailableModels = async () => [];
  try {
    restoreReadyPlan(harness.sidebar, 'parameter-plan', 7);
    const selectionBefore = harness.sidebar.controller.snapshot().selection;
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: '' });
    assert.equal(harness.sidebar.controller.snapshot().plan.build, undefined);

    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'effort', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'fast', value: 'true' });
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'effort', value: 'low' });
    const configured = harness.sidebar.controller.snapshot().plan;
    assert.equal(configured.phase, 'ready');
    assert.equal(configured.current?.id, 'parameter-plan');
    assert.deepEqual(configured.build?.selection.modelParams, [{ id: 'fast', value: 'true' }, { id: 'effort', value: 'low' }]);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selectionBefore);

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'not-in-catalog' }),
      /モデル一覧に、そのモデルはありません/,
    );
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, configured.build);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selectionBefore);
  } finally {
    await close(harness);
  }
});
