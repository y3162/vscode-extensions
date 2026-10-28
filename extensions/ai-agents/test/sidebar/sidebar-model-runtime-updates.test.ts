import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

function openWithFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function session(id: string, onRun?: () => Promise<void>) {
  const models: Selection[] = [];
  const runs: string[] = [];
  const instance: AgentSession = {
    sessionId: id,
    async run(prompt, _signal, emit) {
      runs.push(prompt);
      await onRun?.();
      emit({ id: `${id}-answer-${runs.length}`, role: 'assistant', text: 'done', final: true });
    },
    async setModel(next) { models.push(next); },
    async dispose() {},
  };
  return { instance, models, runs };
}

test('Cursor model changes update the live session for the next send without clearing its conversation', async () => {
  resetVscode();
  const live = session('cursor-live');
  const harness = openWithFactory(async () => live.instance);
  const view = createView();
  const model: AgentModel = { id: 'cursor-next-model', label: 'Cursor next model' };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    harness.sidebar.listAvailableModels = async () => [model];
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'keep this conversation' });
    const sessionId = harness.sidebar.controller.sessionId();
    const priorMessages = harness.sidebar.controller.snapshot().messages.length;

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id });

    assert.equal(harness.sidebar.controller.sessionId(), sessionId);
    assert.deepEqual(live.models, [{ provider: 'cursor', cwd: harness.workspacePath, model: model.id }]);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, priorMessages);
    assert.deepEqual(live.runs, ['keep this conversation']);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.cursor?.model, model.id);
    assert.ok(harness.output.lines.some((line) => line.includes('[cursor/cli]')));
  } finally {
    await close(harness);
  }
});

test('selecting a model while model details are open reuses the active details editor', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-model', label: 'Details model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  try {
    await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
    harness.sidebar.listAvailableModels = async () => [model];
    const editing = harness.sidebar.configureModel();
    await waitFor(() => window.quickPicks.length === 1 && window.quickPicks[0]?.busy === false, 'model details editor');
    const editor = window.quickPicks[0]!;

    await harness.sidebar.selectModel();

    assert.equal(window.quickPicks.length, 1);
    assert.equal(editor.shown, true);
    editor.hide();
    await editing;
    assert.equal(editor.disposed, true);
    assert.equal(harness.sidebar.isModelDetailsReady(), false);
  } finally {
    await close(harness);
  }
});

test('model selection is blocked while its conversation is running', async () => {
  resetVscode();
  let releaseRun!: () => void;
  let runStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const started = new Promise<void>((resolve) => { runStarted = resolve; });
  const running = session('running-picker-session', async () => {
    runStarted();
    await gate;
  });
  const harness = openWithFactory(async () => running.instance);
  try {
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'running turn' });
    await started;
    await assert.rejects(harness.sidebar.selectModel(), /実行が終わってからモデルを選択してください/);
    assert.equal(window.quickPicks.length, 0);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.model, '');
    releaseRun();
    await sending;
  } finally {
    releaseRun();
    await close(harness);
  }
});
