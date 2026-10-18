import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, env, languages, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

test('a successful model refresh replaces the cache used by later menu selections', async () => {
  resetVscode();
  const harness = openSidebar();
  const catalogs: AgentModel[][] = [
    [{ id: 'round12-old-model', label: 'Old model' }],
    [{ id: 'round12-refreshed-model', label: 'Refreshed model' }],
  ];
  let calls = 0;
  harness.sidebar.listAvailableModels = async () => catalogs[calls++] ?? [];
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 120, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 121 });
    assert.equal(calls, 1, 'the ordinary request reuses the first cached result');
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 122, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 123 });
    assert.equal(calls, 2, 'refresh performs a new lookup and populates the cache');
    assert.deepEqual((view.messages.filter((message) => message.type === 'modelCatalog').at(-1)?.models as Array<{ id: string }>).map((item) => item.id), ['round12-refreshed-model']);

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'round12-refreshed-model' });
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round12-refreshed-model');
    await assert.rejects(harness.sidebar.handleMessage({ type: 'setModel', modelId: 'round12-old-model' }), /モデル一覧に、そのモデルはありません/);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round12-refreshed-model');
    assert.equal(calls, 2, 'both menu selections resolve against the refreshed cache');
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.label, 'Refreshed model');
  } finally {
    await close(harness);
  }
});

test('setModel rejects a busy conversation before discovering or persisting a replacement model', async () => {
  resetVscode();
  const entered = deferred<void>();
  const release = deferred<void>();
  const model: AgentModel = { id: 'round12-forbidden-replacement', label: 'Must not be applied' };
  let lookups = 0;
  const harness = withFactory(async () => ({
    sessionId: 'round12-busy-model',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      entered.resolve();
      await release.promise;
      emit({ id: 'round12-busy-final', role: 'assistant', text: 'done', final: true });
    },
    async dispose() {},
  }));
  harness.sidebar.listAvailableModels = async () => { lookups += 1; return [model]; };
  try {
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active protected turn' });
    await entered.promise;
    const before = harness.sidebar.controller.snapshot().selection;
    await assert.rejects(harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id }), /実行が終わってからモデルを選択してください/);

    assert.equal(lookups, 0);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, before);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    release.resolve();
    await sending;
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'done'), true);
  } finally {
    release.resolve();
    await close(harness);
  }
});
