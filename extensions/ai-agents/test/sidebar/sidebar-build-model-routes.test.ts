import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Build routes apply the saved model fallback and acknowledge only the selected build model', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: Selection): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 4, createdAt: 4, source: 'assistant-text', markdown: '# Build' }],
      current: { id: 'late-build', revision: 4, markdown: '# Build', todos: [], source: 'assistant-text', createdAt: 4 },
      build: { selection: { ...state.selection, model: 'saved-build-model', modelParams: [{ id: 'effort', value: 'high' }] }, label: 'Saved model' },
    };
    harness.sidebar.controller.restoreSnapshot(state);
    const builds: Array<{ id: string; revision: number; selection: Selection }> = [];
    controller.build = async (id, revision, selection) => {
      builds.push({ id, revision, selection });
      const next = harness.sidebar.controller.snapshot();
      next.selection = selection;
      next.plan.phase = 'implemented';
      harness.sidebar.controller.restoreSnapshot(next);
    };

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'late-build', revision: 4 });
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.selection.model, 'saved-build-model');
    assert.deepEqual(builds[0]?.selection.modelParams, [{ id: 'effort', value: 'high' }]);
    const saved = harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(saved, { model: 'saved-build-model', label: 'saved-build-model', hasDetails: true, modelParams: [{ id: 'effort', value: 'high' }] });

    const model = { id: 'canonical-build-model', label: '', aliases: ['build-alias'] };
    harness.sidebar.listAvailableModels = async () => [model];
    const readyAgain = harness.sidebar.controller.snapshot();
    readyAgain.plan.phase = 'ready';
    readyAgain.plan.current = { id: 'alias-plan', revision: 5, markdown: '# Alias', todos: [], source: 'assistant-text', createdAt: 5 };
    readyAgain.plan.revisions = [{ revision: 5, createdAt: 5, source: 'assistant-text', markdown: '# Alias' }];
    harness.sidebar.controller.restoreSnapshot(readyAgain);
    await harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'build-alias' });
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.selection.model, 'canonical-build-model');
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.label, 'build-alias');
  } finally {
    await close(harness);
  }
});
