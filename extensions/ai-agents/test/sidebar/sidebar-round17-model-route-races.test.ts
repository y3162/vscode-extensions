import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a rejected catalog request superseded by refresh cannot publish a stale error', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const first = deferred<AgentModel[]>();
  const fresh: AgentModel = { id: 'round17-fresh-catalog', label: 'Fresh catalog model' };
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    calls += 1;
    if (calls === 1) {
      firstSignal = signal;
      return first.promise;
    }
    return [fresh];
  };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    const staleRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 171, refresh: true });
    await waitFor(() => calls === 1, 'first model catalog request');

    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 172, refresh: true });
    assert.equal(firstSignal?.aborted, true, 'refresh aborts the superseded catalog transport');
    first.reject(new Error('stale catalog transport failed'));
    await staleRequest;

    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.deepEqual(catalogs.map((message) => [message.requestId, message.status]), [[172, 'ready']]);
    assert.deepEqual((catalogs[0]?.models as Array<{ id: string }>).map((item) => item.id), [fresh.id]);
    assert.equal(window.errorMessages.some((message) => message.includes('stale catalog transport failed')), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
  } finally {
    first.reject(new Error('test cleanup'));
    await close(harness);
  }
});

test('a send from a known background conversation cannot alter the empty front conversation', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: `round17-background-${runs.length + 1}`,
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `round17-background-answer-${runs.length}`, role: 'assistant', text: `completed ${prompt}`, final: true });
    },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retain background history' });
    const background = harness.sidebar.controller;
    const backgroundId = (view.messages.filter((message) => message.type === 'state').at(-1)?.shell as { conversationId?: string } | undefined)?.conversationId;
    assert.ok(backgroundId);

    await harness.sidebar.newChat();
    const front = harness.sidebar.controller;
    const frontBefore = front.snapshot();
    const backgroundBefore = background.snapshot();
    await harness.sidebar.handleMessage({
      type: 'send', conversationId: backgroundId, provider: 'codex', cwd: harness.workspacePath, prompt: 'must not run from a stale view',
    });

    assert.deepEqual(runs, ['retain background history']);
    assert.deepEqual(front.snapshot(), frontBefore, 'the stale event cannot create user content or start work on the front');
    assert.deepEqual(background.snapshot(), backgroundBefore, 'the stale event cannot append to the background conversation');
    assert.equal(front.hasSession(), false);
  } finally {
    await close(harness);
  }
});

test('a send that becomes busy during model lookup blocks model commit without disturbing the active turn', async () => {
  resetVscode();
  const catalog = deferred<AgentModel[]>();
  const runEntered = deferred<void>();
  const releaseRun = deferred<void>();
  const selectedModel: AgentModel = { id: 'round17-busy-selection', label: 'Must not replace during run' };
  let lookups = 0;
  let factoryCalls = 0;
  const harness = withFactory(async () => {
    factoryCalls += 1;
    return {
      sessionId: 'round17-busy-selection-session',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        runEntered.resolve();
        await releaseRun.promise;
        emit({ id: 'round17-busy-selection-answer', role: 'assistant', text: 'turn completed safely', final: true });
      },
      async dispose() {},
    };
  });
  harness.sidebar.listAvailableModels = async () => { lookups += 1; return catalog.promise; };
  try {
    const choosing = harness.sidebar.handleMessage({ type: 'setModel', modelId: selectedModel.id });
    await waitFor(() => lookups === 1, 'model lookup to begin');
    const originalSelection = harness.sidebar.controller.snapshot().selection;
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'protect the active turn' });
    await runEntered.promise;

    catalog.resolve([selectedModel]);
    await assert.rejects(choosing, /実行が終わってからモデルを選択してください/);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, originalSelection);
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(factoryCalls, 1, 'the model change does not open a second backend session');

    releaseRun.resolve();
    await sending;
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'turn completed safely'));
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, originalSelection);
  } finally {
    catalog.resolve([selectedModel]);
    releaseRun.resolve();
    await close(harness);
  }
});

test('a model lookup completed after provider and cwd change cannot overwrite the current selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const secondWorkspace = path.join(harness.root, 'round17-second-workspace');
  mkdirSync(secondWorkspace);
  workspace.workspaceFolders?.push({ name: 'second', uri: Uri.file(secondWorkspace), index: 1 });
  const staleModel: AgentModel = { id: 'round17-stale-model', label: 'Stale Codex choice' };
  const lookup = deferred<AgentModel[]>();
  let started = false;
  harness.sidebar.listAvailableModels = async () => { started = true; return lookup.promise; };
  try {
    const choosing = harness.sidebar.handleMessage({ type: 'setModel', modelId: staleModel.id });
    await waitFor(() => started, 'stale Codex model lookup');
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: secondWorkspace });
    lookup.resolve([staleModel]);
    await choosing;

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.selection.provider, 'cursor');
    assert.equal(state.selection.cwd, secondWorkspace);
    assert.notEqual(state.selection.model, staleModel.id);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(state.messages.length, 0);
    assert.equal(harness.sidebar.controller.hasSession(), false);
  } finally {
    lookup.resolve([staleModel]);
    await close(harness);
  }
});

test('changing a menu model in an empty conversation does not ask to discard a conversation', async () => {
  resetVscode();
  const harness = openSidebar();
  const replacement: AgentModel = { id: 'round17-empty-conversation-model', label: 'Replacement without prompt history' };
  await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: 'existing-model' });
  harness.sidebar.listAvailableModels = async () => [replacement];
  try {
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: replacement.id });

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.selection.model, replacement.id);
    assert.equal(state.messages.length, 0);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.deepEqual(window.warningMessages, [], 'an empty conversation needs no confirmation before model selection');
    assert.deepEqual(
      harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex,
      { model: replacement.id, label: replacement.label, hasDetails: false },
    );
  } finally {
    await close(harness);
  }
});
