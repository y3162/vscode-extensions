import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, PlanState } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a model lookup that completes after newChat cannot apply to the replacement conversation', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async () => ({
    sessionId: 'stale-model-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: 'stale-model-answer', role: 'assistant', text: 'old conversation answer', final: true });
    },
    async dispose() {},
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const entered = deferred<void>();
  const result = deferred<AgentModel[]>();
  sidebar.listAvailableModels = async () => {
    entered.resolve();
    return result.promise;
  };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'keep this conversation isolated' });
    const previous = sidebar.controller;
    const pending = sidebar.handleMessage({ type: 'setModel', modelId: 'late-model' });
    await entered.promise;
    await sidebar.handleMessage({ type: 'newChat' });
    const replacement = sidebar.controller;
    assert.notEqual(replacement, previous);

    result.resolve([{ id: 'late-model', label: 'Late model' }]);
    await pending;

    assert.equal(replacement.snapshot().selection.model, '');
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.equal(previous.snapshot().selection.model, '');
    assert.ok(previous.snapshot().messages.some((message) => message.text === 'keep this conversation isolated'));
    assert.equal(paths.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    result.resolve([]);
    await close(harness);
  }
});
