import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentSession, AgentUpdate, Selection, SessionSummary } from '../../src/types.js';

import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('malformed Build requests do not mutate a plan, while typed fallbacks use its saved selection', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: Selection): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 6, createdAt: 6, source: 'assistant-text', markdown: '# Saved build' }],
      current: { id: 'saved-plan', revision: 6, markdown: '# Saved build', todos: [], source: 'assistant-text', createdAt: 6 },
      build: { selection: { ...state.selection, model: 'saved-model', modelParams: [{ id: 'effort', value: 'high' }] }, label: 'Saved model' },
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

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 6, revision: '6' });
    assert.equal(builds.length, 0, 'invalid plan id and revision are rejected by the ready-plan guard');
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'ready');

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'saved-plan', revision: 6, modelId: 8, modelParams: 'malformed' });
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.selection.model, 'saved-model', 'non-string model IDs fall back to the saved Build model');
    assert.deepEqual(builds[0]?.selection.modelParams, [{ id: 'effort', value: 'high' }], 'non-array parameters fall back to saved Build parameters');
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex, {
      model: 'saved-model', label: 'saved-model', hasDetails: true, modelParams: [{ id: 'effort', value: 'high' }],
    });

    const noBuild = harness.sidebar.controller.snapshot();
    noBuild.plan.phase = 'ready';
    noBuild.plan.current = { id: 'empty-build', revision: 7, markdown: '# Empty Build', todos: [], source: 'assistant-text', createdAt: 7 };
    noBuild.plan.revisions = [{ revision: 7, createdAt: 7, source: 'assistant-text', markdown: '# Empty Build' }];
    delete noBuild.plan.build;
    harness.sidebar.controller.restoreSnapshot(noBuild);
    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'empty-build', revision: 7 });
    const selected = harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(selected, { model: '', label: 'Select model', hasDetails: false });
  } finally {
    await close(harness);
  }
});
