import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

function completedSession(id: string, setModel?: (selection: Selection) => Promise<void>): AgentSession {
  return {
    sessionId: id,
    async run(prompt, _signal, emit) {
      emit({ id: `${id}-answer`, role: 'assistant', text: `completed: ${prompt}`, final: true });
    },
    async setModel(selection) { await setModel?.(selection); },
    async dispose() {},
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a backend model change failure preserves the live conversation and saved selection', async () => {
  resetVscode();
  let factoryCalls = 0;
  const harness = withSession(async () => {
    factoryCalls += 1;
    return completedSession('model-change-fails', async () => { throw new Error('synthetic setModel rejection'); });
  });
  const model: AgentModel = { id: 'rejected-model', label: 'Rejected model' };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'preserve this conversation' });
    const before = harness.sidebar.controller.snapshot();
    const sessionId = harness.sidebar.controller.sessionId();

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id }),
      /synthetic setModel rejection/,
    );

    const after = harness.sidebar.controller.snapshot();
    assert.deepEqual(after.selection, before.selection);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.busy, false);
    assert.equal(harness.sidebar.controller.sessionId(), sessionId);
    assert.equal(factoryCalls, 1, 'a failed in-session model update must not construct a replacement session');
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
  } finally {
    await close(harness);
  }
});

test('a delayed model lookup cannot apply to a different provider selected while it is pending', async () => {
  resetVscode();
  const harness = openSidebar();
  const lookupStarted = deferred<void>();
  const releaseModels = deferred<AgentModel[]>();
  harness.sidebar.listAvailableModels = async () => {
    lookupStarted.resolve();
    return releaseModels.promise;
  };
  try {
    const changing = harness.sidebar.handleMessage({ type: 'setModel', modelId: 'old-provider-model' });
    await lookupStarted.promise;
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    releaseModels.resolve([{ id: 'old-provider-model', label: 'Old provider model' }]);
    await changing;

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.selection.provider, 'cursor');
    assert.equal(state.selection.model, 'auto');
    assert.equal(state.messages.length, 0);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    releaseModels.resolve([]);
    await close(harness);
  }
});
