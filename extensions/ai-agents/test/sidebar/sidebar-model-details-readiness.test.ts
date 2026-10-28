import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model details exposes active readiness, reuses its editor, and rejects changes while a run is active', async () => {
  resetVscode();
  const runStarted = deferred<void>();
  const releaseRun = deferred<void>();
  const calls: string[] = [];
  const harness = withSession(async () => ({
    sessionId: 'round10-model-details',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      calls.push(prompt);
      runStarted.resolve();
      await releaseRun.promise;
      emit({ id: 'round10-final', role: 'assistant', text: 'finished', final: true });
    },
    async dispose() {},
  }));
  const model: AgentModel = {
    id: 'round10-details-model', label: 'Round10 model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
    const editing = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'details editor ready');
    const picker = window.quickPicks.at(-1)!;
    assert.equal(harness.sidebar.isModelDetailsReady(), false, 'readiness requires an active details item');

    const parameter = picker.items.find((item) => (item as { id?: string }).id === 'parameter:effort');
    assert.ok(parameter);
    picker.activate([parameter]);
    assert.equal(harness.sidebar.isModelDetailsReady('parameter:effort'), true);
    assert.equal(harness.sidebar.isModelDetailsReady('parameter:missing'), false);

    await harness.sidebar.handleMessage({ type: 'modelDetails' });
    assert.equal(window.quickPicks.length, 1, 'reopening details reuses its active picker');
    assert.equal(picker.shown, true);
    picker.hide();
    await editing;
    assert.equal(picker.disposed, true);

    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'hold model settings stable' });
    await runStarted.promise;
    const before = harness.sidebar.controller.snapshot().selection;
    await assert.rejects(harness.sidebar.handleMessage({ type: 'modelDetails' }), /実行が終わってから詳細設定を変更してください/);
    assert.equal(window.quickPicks.length, 1, 'busy guard rejects before creating another picker');
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, before);
    assert.deepEqual(calls, ['hold model settings stable']);
    assert.equal(harness.sidebar.controller.snapshot().busy, true);

    releaseRun.resolve();
    await sending;
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
  } finally {
    releaseRun.resolve();
    await close(harness);
  }
});
