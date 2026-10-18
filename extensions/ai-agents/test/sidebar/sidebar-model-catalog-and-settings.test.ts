import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection, SendExtras, SessionSummary, TerminalRecord } from '../../src/types.js';

import { commands, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness, type TestView } from '../support/vscode-harness.js';

function fakeSession(id: string): FakeSession {
  const session: FakeSession = {
    sessionId: id,
    disposed: 0,
    modes: [],
    runs: [],
    sessions: [],
    models: [],
    terminals: [],
    terminated: [],
    compactCalls: 0,
    reviews: [],
    async run(prompt, _signal, emit, extras, turn) {
      session.runs.push({ prompt, extras, selection: turn?.selection });
      if (session.runGate) await session.runGate;
      if (session.failRun) throw session.failRun;
      emit({ id: `${id}-final`, role: 'assistant', text: 'completed by fixture', final: true });
    },
    async setMode(mode) { session.modes.push(mode); },
    async setModel(selection) {
      if (session.failSetModel) throw session.failSetModel;
      session.models.push(selection);
    },
    async compact() { session.compactCalls += 1; },
    async review(target, emit) {
      session.reviews.push(target);
      emit({ id: `${id}-review`, role: 'assistant', text: 'reviewed by fixture', final: true });
    },
    async listSessions() {
      if (session.failListSessions) throw session.failListSessions;
      return session.sessions;
    },
    async listBackgroundTerminals() { return session.terminals; },
    async terminateBackgroundTerminal(processId) {
      session.terminated.push(processId);
      session.terminals = session.terminals.filter((row) => row.processId !== processId);
    },
    async dispose() { session.disposed += 1; },
  };
  return session;
}

function installFakeFactory(harness: Harness, create: (selection: Selection) => AgentSession): void {
  const controller = harness.sidebar.controller as unknown as {
    factory: (selection: Selection, context?: { signal?: AbortSignal; resumeId?: string }) => Promise<AgentSession>;
  };
  controller.factory = async (selection) => create(selection);
}

async function ready(sidebar: Harness['sidebar'], view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

interface FakeSession extends AgentSession {
  disposed: number;
  modes: string[];
  runs: RunCall[];
  sessions: SessionSummary[];
  models: Selection[];
  terminals: TerminalRecord[];
  terminated: string[];
  compactCalls: number;
  reviews: Array<'uncommitted' | 'base'>;
  failListSessions?: Error;
  failRun?: Error;
  failSetModel?: Error;
  runGate?: Promise<void>;
}

interface RunCall {
  prompt: string;
  extras?: SendExtras;
  selection?: Selection;
}

test('a stale model catalog request is discarded after a newer request replaces it', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    let releaseOld!: (models: Array<{ id: string; label: string }>) => void;
    const oldResult = new Promise<Array<{ id: string; label: string }>>((resolve) => { releaseOld = resolve; });
    let calls = 0;
    harness.sidebar.listAvailableModels = async () => {
      calls += 1;
      return calls === 1 ? oldResult : [{ id: 'new-model', label: 'New model' }];
    };

    const oldRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 21, refresh: true });
    const latestRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 22, refresh: true });
    await latestRequest;
    releaseOld([{ id: 'stale-model', label: 'Stale model' }]);
    await oldRequest;

    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.equal(catalogs.length, 1);
    assert.equal(catalogs[0]?.requestId, 22);
    assert.deepEqual((catalogs[0]?.models as Array<{ id: string }>).map((model) => model.id), ['new-model']);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 23 });
    assert.equal(calls, 2, 'a non-refresh request should use the catalog cache');
    assert.equal(view.messages.filter((message) => message.type === 'modelCatalog').at(-1)?.requestId, 23);
  } finally {
    await close(harness);
  }
});

test('a model catalog result is discarded after the selected provider changes mid-request', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  let release!: (models: Array<{ id: string; label: string }>) => void;
  const delayed = new Promise<Array<{ id: string; label: string }>>((resolve) => { release = resolve; });
  let started = false;
  harness.sidebar.listAvailableModels = async () => {
    started = true;
    return delayed;
  };
  try {
    await ready(harness.sidebar, view);
    const request = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 31, refresh: true });
    await waitFor(() => started, 'catalog request to start');
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    release([{ id: 'codex-result', label: 'Old provider model' }]);
    await request;
    assert.equal(view.messages.some((message) => message.type === 'modelCatalog' && message.requestId === 31), false);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});

test('model picker applies the active catalog item and releases picker state after acceptance', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const model: AgentModel = {
    id: 'picker-model', label: 'Picker model', aliases: ['picker-alias'], isDefault: true,
    defaultParams: [{ id: 'effort', value: 'high' }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await ready(harness.sidebar, view);
    const choosing = harness.sidebar.handleMessage({ type: 'chooseModel' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false && window.quickPicks.at(-1)?.items.length === 1, 'picker model');
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.matchOnDescription, true);
    assert.equal(picker.matchOnDetail, true);
    picker.selectedItems = [picker.items[0]!];
    picker.activate([picker.items[0]!]);
    assert.equal(harness.sidebar.isModelPickerReady(), true);
    assert.equal(harness.sidebar.isModelPickerReady('picker-model'), true);
    assert.equal(harness.sidebar.isModelPickerReady('other-model'), false);
    picker.accept();
    await choosing;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'picker-model');
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex, {
      model: 'picker-model', label: 'Picker model', hasDetails: false,
      modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.isModelPickerReady(), false);
  } finally {
    await close(harness);
  }
});

test('Cursor model catalog cancels stale results, reports the current error, then caches a successful refresh', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  let calls = 0;
  let releaseStale!: (models: AgentModel[]) => void;
  const staleResult = new Promise<AgentModel[]>((resolve) => { releaseStale = resolve; });
  const freshModel: AgentModel = { id: 'cursor-fresh', label: 'Cursor fresh model' };
  harness.sidebar.listAvailableModels = async (selection, signal) => {
    calls += 1;
    assert.ok(selection);
    assert.equal(selection.provider, 'cursor');
    assert.ok(signal instanceof AbortSignal);
    if (calls === 1) return staleResult;
    if (calls === 2) throw new Error('synthetic Cursor catalog failure');
    return [freshModel];
  };
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });

    const staleRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 41, refresh: true });
    await waitFor(() => calls === 1, 'first Cursor catalog request');
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 42, refresh: true });
    releaseStale([{ id: 'cursor-stale', label: 'Stale Cursor model' }]);
    await staleRequest;

    const afterFailure = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.equal(afterFailure.length, 1);
    assert.equal(afterFailure[0]?.requestId, 42);
    assert.equal(afterFailure[0]?.status, 'error');
    assert.match(String(afterFailure[0]?.error), /synthetic Cursor catalog failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);

    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 43, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 44 });
    assert.equal(calls, 3, 'the unrefreshed request should use the successful Cursor cache');
    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.deepEqual(catalogs.map((message) => [message.requestId, message.status]), [[42, 'error'], [43, 'ready'], [44, 'ready']]);
    assert.deepEqual((catalogs.at(-1)?.models as Array<{ id: string }>).map((model) => model.id), ['cursor-fresh']);
  } finally {
    await close(harness);
  }
});

test('model parameter events preserve current settings for invalid input, stale lookup, and a busy conversation', async () => {
  resetVscode();
  const harness = openSidebar();
  const secondWorkspace = path.join(harness.root, 'second-workspace');
  mkdirSync(secondWorkspace);
  workspace.workspaceFolders?.push({ name: 'second', uri: Uri.file(secondWorkspace), index: 1 });
  const model: AgentModel = {
    id: 'model-with-effort', label: 'Model with effort',
    parameters: [{ id: 'effort', label: 'Effort', values: [
      { value: 'low', label: 'Low' }, { value: 'high', label: 'High' },
    ] }],
  };
  let secondWorkspaceLookup!: (models: AgentModel[]) => void;
  const delayedModels = new Promise<AgentModel[]>((resolve) => { secondWorkspaceLookup = resolve; });
  let lookupCount = 0;
  harness.sidebar.listAvailableModels = async (selection) => {
    lookupCount += 1;
    assert.ok(selection);
    return selection.cwd === secondWorkspace ? delayedModels : [model];
  };
  try {
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: '', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'unknown', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'unsupported' });
    assert.equal(lookupCount, 1);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);

    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    await harness.sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: secondWorkspace });
    const staleParameter = harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'low' });
    await waitFor(() => lookupCount === 2, 'parameter lookup for the second workspace');
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    secondWorkspaceLookup([model]);
    await staleParameter;
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, harness.workspacePath);
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);
  } finally {
    secondWorkspaceLookup([]);
    await close(harness);
  }

  resetVscode();
  const busyHarness = openSidebar();
  const session = fakeSession('busy-param-session');
  let releaseRun!: () => void;
  session.runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  installFakeFactory(busyHarness, () => session);
  let modelLookups = 0;
  busyHarness.sidebar.listAvailableModels = async () => { modelLookups += 1; return [model]; };
  try {
    const running = busyHarness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: busyHarness.workspacePath, prompt: 'long running turn' });
    await waitFor(() => session.runs.length === 1 && busyHarness.sidebar.controller.snapshot().busy, 'active turn');
    const selectionBefore = busyHarness.sidebar.controller.snapshot().selection;
    await assert.rejects(
      () => busyHarness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' }),
      /実行が終わってからモデルを選択してください/,
    );
    assert.equal(modelLookups, 0);
    assert.deepEqual(busyHarness.sidebar.controller.snapshot().selection, selectionBefore);
    releaseRun();
    await running;
    assert.equal(busyHarness.sidebar.controller.snapshot().busy, false);
  } finally {
    releaseRun();
    await close(busyHarness);
  }
});

test('model picker recovers from a list failure when the user refreshes', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = { id: 'retry-picker-model', label: 'Retry picker model' };
  let calls = 0;
  harness.sidebar.listAvailableModels = async () => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic catalog outage');
    return [model];
  };
  try {
    await ready(harness.sidebar, createView());
    const choosing = harness.sidebar.handleMessage({ type: 'chooseModel' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'failed picker load');
    const picker = window.quickPicks.at(-1)!;
    assert.deepEqual(picker.items, []);
    assert.match(picker.placeholder, /取得に失敗/);
    assert.ok(window.errorMessages.some((message) => message.includes('synthetic catalog outage')));

    picker.triggerButton();
    await waitFor(() => picker.busy === false && picker.items.length === 1, 'picker refresh');
    picker.selectedItems = [picker.items[0]!];
    picker.activate([picker.items[0]!]);
    picker.accept();
    await choosing;

    assert.equal(calls, 2);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'retry-picker-model');
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex?.model, 'retry-picker-model');
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});
