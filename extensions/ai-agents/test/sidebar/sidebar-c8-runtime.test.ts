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
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
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
    assert.ok(harness.output.lines.some((line) => line.includes('[cursor/sdk]')));
  } finally {
    await close(harness);
  }
});

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

test('the sidebar accepts a prompt exactly at its character limit', async () => {
  resetVscode();
  const live = session('maximum-prompt-session');
  const harness = openWithFactory(async () => live.instance);
  const prompt = 'x'.repeat(100_000);
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt });

    assert.deepEqual(live.runs, [prompt]);
    assert.equal(harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user')?.text.length, 100_000);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
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
