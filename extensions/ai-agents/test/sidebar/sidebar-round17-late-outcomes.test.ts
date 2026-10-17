import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { AgentSession, AgentUpdate, SendExtras } from '../../src/types.js';
import { AgentsSidebar } from '../../src/sidebar.js';
import { env, resetVscode, window } from '../support/vscode-stub.js';
import { openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('retry replaces saved images with newly supplied retry images while preserving the prompt', async () => {
  resetVscode();
  const runs: Array<{ prompt: string; extras?: SendExtras }> = [];
  const harness = withSession(async () => ({
    sessionId: 'round17-image-retry',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras) {
      runs.push({ prompt, extras });
      emit({ id: `round17-image-answer-${runs.length}`, role: 'assistant', text: 'image reviewed', final: true });
    },
    async dispose() {},
  }));
  const originalImage = { mimeType: 'image/png', data: 'aGVsbG8=', name: 'original.png' };
  const replacementImage = { mimeType: 'image/jpeg', data: 'bmV3LWltYWdl', name: 'replacement.jpg' };

  try {
    const prompt = 'Compare this image with the previous result';
    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt, images: [originalImage],
    });
    const originalUser = harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user');
    assert.ok(originalUser, 'the first image turn is recorded before retry is prepared');
    assert.deepEqual(runs[0]?.extras?.images, [originalImage]);

    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: originalUser.id });
    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt, images: [replacementImage],
    });

    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.prompt, runs[0]?.prompt, 'retry keeps the original expanded prompt');
    assert.equal(runs[1]?.extras?.retryOf, originalUser.id);
    assert.deepEqual(runs[1]?.extras?.images, [replacementImage], 'newly supplied image replaces the saved image payload');
    assert.deepEqual(
      harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.id),
      [originalUser.id],
      'retry updates the existing turn instead of creating a duplicate user turn',
    );
  } finally {
    await close(harness);
  }
});

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
