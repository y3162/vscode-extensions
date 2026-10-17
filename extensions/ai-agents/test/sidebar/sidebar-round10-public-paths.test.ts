import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
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

test('unsupported built-in review expands referenced files into the sent prompt without invoking review API', async () => {
  resetVscode();
  const runs: string[] = [];
  const reviews: string[] = [];
  const harness = withSession(async () => ({
    sessionId: 'round10-review-fallback',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `round10-answer-${runs.length}`, role: 'assistant', text: 'processed', final: true });
    },
    async review(target: 'uncommitted' | 'base') { reviews.push(target); },
    async dispose() {},
  }));
  writeFileSync(path.join(harness.workspacePath, 'review-notes.md'), 'synthetic review context');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed the SDK session' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/review @review-notes.md' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/review' });

    assert.equal(reviews.length, 0, 'the SDK capability policy routes review through the prompt fallback');
    assert.equal(runs.length, 3);
    assert.match(runs[1] ?? '', /--- Context: review-notes\.md ---/);
    assert.match(runs[1] ?? '', /synthetic review context/);
    assert.match(runs[1] ?? '', /@review-notes\.md/);
    assert.match(runs[1] ?? '', /git status:\n/);
    assert.match(runs[2] ?? '', /Review the current changes\./, 'a bare built-in uses the default review instruction');
    assert.match(runs[2] ?? '', /git status:\n/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user' && message.text === '/review @review-notes.md'), true);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'processed'), true);
  } finally {
    await close(harness);
  }
});

test('login ignores a stale conversation action and still signs in from the current front route', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep this conversation in the background' });
    await waitFor(() => view.messages.some((message) => message.type === 'state' && (message.shell as { conversationId?: string } | undefined)?.conversationId === 'front'), 'initial conversation identity');

    await harness.sidebar.handleMessage({ type: 'newChat' });
    await harness.sidebar.handleMessage({ type: 'login', conversationId: 'front' });
    assert.equal(window.terminals.length, 0, 'a login click from an older conversation cannot affect the new front');
    assert.equal(commands.executed.some((entry) => entry.command === 'ai-agents.cursorLogin'), false);

    await harness.sidebar.handleMessage({ type: 'login' });
    assert.equal(window.terminals.length, 1);
    assert.equal(window.terminals[0]?.name, 'Codex Login');
    assert.deepEqual(window.terminals[0]?.sent, ['codex login']);
    assert.equal(window.terminals[0]?.shown, 1);
  } finally {
    await close(harness);
  }
});

test('restore backend failure leaves an error state and logs the failure without claiming a live session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'round10-unavailable-resume', title: 'Synthetic saved session', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'sdk', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    throw new Error('synthetic backend unavailable');
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const view = createView();
  try {
    sidebar.resolveWebviewView(view as never);
    await sidebar.handleMessage({ type: 'ready' }, view as never);
    view.receive({ type: 'restoreSession', id: summary.id });
    await waitFor(() => sidebar.controller.snapshot().messages.some((message) => message.role === 'error' && message.text.includes('synthetic backend unavailable')), 'restore failure state');

    const state = sidebar.controller.snapshot();
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.hasSession(), false);
    assert.equal(state.status, 'error');
    assert.match(state.messages.find((message) => message.role === 'error')?.text ?? '', /synthetic backend unavailable/);
    assert.ok(output.lines.some((line) => line.includes('synthetic backend unavailable')));
    await waitFor(() => view.messages.some((message) => message.type === 'state' && JSON.stringify(message.messages).includes('synthetic backend unavailable')), 'restore error rendered in the webview');
    assert.equal(window.errorMessages.length, 0, 'the controller preserves the failure as visible session state and logs it once');
  } finally {
    await close(harness);
  }
});

