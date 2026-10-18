import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('saved model labels migrate to their base name while selection parameters are restored', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  await paths.context.workspaceState.update('ai-agents.selectedModels', {
    codex: {
      model: 'gpt-synthetic', label: 'GPT Synthetic — High 1M', hasDetails: true,
      modelParams: [{ id: 'modelReasoningEffort', value: 'high' }],
    },
    cursor: { model: 'auto', label: 'Cursor — Fast', hasDetails: false },
  });
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'saved-model', async run() {}, async dispose() {},
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const view = createView();
  try {
    assert.equal(sidebar.controller.snapshot().selection.model, 'gpt-synthetic');
    assert.deepEqual(sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'high' }]);
    sidebar.resolveWebviewView(view as never);
    await sidebar.handleMessage({ type: 'ready' }, view as never);
    const state = view.messages.filter((message) => message.type === 'state').at(-1) as { shell?: { modelLabel?: string; effortLabel?: string | null } } | undefined;
    assert.equal(state?.shell?.modelLabel, 'GPT Synthetic');
    assert.match(state?.shell?.effortLabel ?? '', /high/i);
    assert.equal(paths.context.workspaceState.get<Record<string, { label: string }>>('ai-agents.selectedModels')?.cursor?.label, 'Cursor');
  } finally {
    await close(harness);
  }
});
