import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a delayed Cursor model update remains owned by its original conversation after the front changes', async () => {
  resetVscode();
  const updateEntered = deferred<void>();
  const releaseUpdate = deferred<void>();
  const applied: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: 'round13-cursor-owner',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: 'round13-cursor-answer', role: 'assistant', text: 'cursor conversation', final: true });
    },
    async setModel(selection) {
      applied.push(selection.model);
      updateEntered.resolve();
      await releaseUpdate.promise;
    },
    async dispose() {},
  }));
  const model: AgentModel = { id: 'round13-next-model', label: 'Next send model' };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'keep this Cursor conversation' });
    const original = harness.sidebar.controller;
    const originalSessionId = original.sessionId();
    const choosing = harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id });
    await updateEntered.promise;

    await harness.sidebar.handleMessage({ type: 'newChat' });
    const replacement = harness.sidebar.controller;
    releaseUpdate.resolve();
    await choosing;

    assert.notEqual(replacement, original);
    assert.equal(original.sessionId(), originalSessionId);
    assert.equal(original.snapshot().selection.model, model.id, 'the delayed update stays with its original session owner');
    assert.equal(replacement.snapshot().selection.provider, 'cursor');
    assert.equal(replacement.snapshot().selection.model, 'auto');
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined, 'a stale editor cannot persist into the new front');
    assert.deepEqual(applied, [model.id]);
  } finally {
    releaseUpdate.resolve();
    await close(harness);
  }
});

test('model catalog in a workspace-free state reports an error without assigning a fake cwd', async () => {
  resetVscode();
  const harness = openSidebar(undefined, { folders: false });
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 130, refresh: true });

    const catalog = view.messages.filter((message) => message.type === 'modelCatalog').at(-1);
    assert.equal(catalog?.requestId, 130);
    assert.equal(catalog?.provider, 'codex');
    assert.equal(catalog?.cwd, '');
    assert.equal(catalog?.status, 'error');
    assert.match(String(catalog?.error), /終了しました|通信が切断|ENOENT|failed|error/i);
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, '');
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
    assert.equal(harness.sidebar.controller.hasSession(), false);
  } finally {
    await close(harness);
  }
});
