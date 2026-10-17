import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, window, workspace } from '../support/vscode-stub.js';
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

function restoreReadyPlan(sidebar: AgentsSidebar, id: string, revision: number): void {
  const state = sidebar.controller.snapshot();
  state.plan = {
    phase: 'ready',
    revisions: [{ revision, createdAt: revision, source: 'assistant-text', markdown: `# Plan ${revision}` }],
    current: { id, revision, markdown: `# Plan ${revision}`, todos: [], source: 'assistant-text', createdAt: revision },
  };
  sidebar.controller.restoreSnapshot(state);
}

test('a slower model parameter lookup cannot overwrite a newer value in the same conversation', async () => {
  resetVscode();
  const model: AgentModel = {
    id: 'raced-model', label: 'Raced model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  const harness = openSidebar(() => { workspace.configuration['ai-agents']!['codex.model'] = model.id; });
  const firstLookupStarted = deferred<void>();
  const firstLookup = deferred<AgentModel[]>();
  let lookups = 0;
  harness.sidebar.listAvailableModels = async () => {
    lookups += 1;
    if (lookups === 1) {
      firstLookupStarted.resolve();
      return firstLookup.promise;
    }
    return [model];
  };
  try {
    const staleLow = harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'low' });
    await firstLookupStarted.promise;
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);

    firstLookup.resolve([model]);
    await staleLow;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex?.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    firstLookup.resolve([]);
    await close(harness);
  }
});

test('a sandbox confirmation cannot apply after another settings change supersedes it', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  let disposed = 0;
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'settings-race-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: 'settings-race-answer', role: 'assistant', text: 'session is live', final: true });
    },
    async dispose() { disposed += 1; },
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const promptShown = deferred<void>();
  const confirmation = deferred<string | undefined>();
  const originalWarning = window.showWarningMessage;
  window.showWarningMessage = (message: string) => {
    assert.match(message, /サンドボックスを無効/);
    promptShown.resolve();
    return confirmation.promise;
  };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: paths.workspacePath, prompt: 'keep policy safe' });
    const sessionMessages = sidebar.controller.snapshot().messages;
    const disabling = sidebar.handleMessage({ type: 'configure', sandbox: 'disabled' });
    await promptShown.promise;

    await sidebar.handleMessage({ type: 'configure', backend: 'acp' });
    confirmation.resolve('保護を解除する');
    await disabling;

    const saved = paths.context.workspaceState.get<Record<string, { sandbox: string; backend: string }>>('ai-agents.controls')?.cursor;
    assert.equal(saved?.sandbox, 'enabled');
    assert.equal(saved?.backend, 'acp');
    assert.equal(disposed, 1, 'the independent network setting change safely reset the active session once');
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.text === 'keep policy safe'), false);
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('設定を変更')));
    assert.ok(sessionMessages.some((message) => message.text === 'keep policy safe'));
  } finally {
    confirmation.resolve(undefined);
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});

test('Build parameters replace by id, preserve other settings, and reject an unknown Build model safely', async () => {
  resetVscode();
  const harness = openSidebar();
  harness.sidebar.listAvailableModels = async () => [];
  try {
    restoreReadyPlan(harness.sidebar, 'parameter-plan', 7);
    const selectionBefore = harness.sidebar.controller.snapshot().selection;
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: '' });
    assert.equal(harness.sidebar.controller.snapshot().plan.build, undefined);

    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'effort', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'fast', value: 'true' });
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'effort', value: 'low' });
    const configured = harness.sidebar.controller.snapshot().plan;
    assert.equal(configured.phase, 'ready');
    assert.equal(configured.current?.id, 'parameter-plan');
    assert.deepEqual(configured.build?.selection.modelParams, [{ id: 'fast', value: 'true' }, { id: 'effort', value: 'low' }]);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selectionBefore);

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'not-in-catalog' }),
      /モデル一覧に、そのモデルはありません/,
    );
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, configured.build);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selectionBefore);
  } finally {
    await close(harness);
  }
});

test('Cursor restore offers its backend choices and cancellation does not create a resumed session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'cursor-indexed-thread', title: 'Cursor history', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: paths.workspacePath });
    window.quickPickQueue.push(undefined);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.deepEqual(window.quickPickOffers.at(-1), ['sdk', 'acp']);
    assert.equal(optionsSeen.length, 0);
    assert.equal(sidebar.controller.sessionId(), undefined);

    window.quickPickQueue.push('acp');
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.backend, 'acp');
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});

test('Codex diagnostics report a synthetic successful CLI check and redact its output', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const executable = path.join(harness.root, 'synthetic-codex.cjs');
  writeFileSync(executable, "process.stdout.write('Codex fixture 0.1\\n');\nprocess.stderr.write('api_key=fixture-secret-value\\n');\n");
  workspace.configuration['ai-agents']!['codex.executablePath'] = executable;
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /OK Codex CLI \(override\)/);
    assert.match(report, /Codex fixture 0\.1/);
    assert.match(report, /api_key=\[redacted\]/);
    assert.doesNotMatch(report, /fixture-secret-value/);
    assert.match(report, /OK Backend\ncodex\/sdk/);
  } finally {
    await close(harness);
  }
});
