import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';
import type { SessionOptions as ProviderSessionOptions } from '../../src/providers/session-options.js';
import { commands, resetVscode, window } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withSession(factory: (options: ProviderSessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function rewindSession(runs: string[], forks: string[]): AgentSession {
  return {
    sessionId: 'rewind-race-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `rewind-answer-${runs.length}`, role: 'assistant', text: `answer ${prompt}`, final: true, backendTurnId: `backend-turn-${runs.length}` });
    },
    async forkBeforeTurn(turnId: string) { forks.push(turnId); return `fork-${turnId}`; },
    async dispose() {},
  };
}

test('model details does not overwrite a concurrent parameter change made through the settings route', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-race-model', label: 'Details race model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  await harness.sidebar.controller.select({ provider: 'codex', cwd: harness.workspacePath, model: model.id });
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    const editing = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'model details catalog');
    const picker = window.quickPicks.at(-1)!;
    const effort = picker.items.find((item) => (item as { id?: string }).id === 'parameter:effort');
    assert.ok(effort);
    picker.selectedItems = [effort];
    picker.accept();
    const low = picker.items.find((item) => (item as { id?: string }).id === 'value:effort:low');
    assert.ok(low);
    picker.selectedItems = [low];
    picker.accept();

    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    const apply = picker.items.find((item) => (item as { action?: string }).action === 'apply');
    assert.ok(apply);
    picker.selectedItems = [apply];
    picker.accept();
    await editing;

    assert.deepEqual(harness.sidebar.controller.snapshot().selection, {
      provider: 'codex', cwd: harness.workspacePath, model: model.id, modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex?.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});

test('rewind stops before confirmation if the front conversation changes while preparing the preview', async () => {
  resetVscode();
  const runs: string[] = [];
  const forks: string[] = [];
  const harness = withSession(async () => rewindSession(runs, forks));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep original turn' });
    const previous = harness.sidebar.controller;
    const before = previous.snapshot();
    const turnId = before.turns[0]?.id;
    assert.ok(turnId);
    const entered = deferred<void>();
    const release = deferred<void>();
    previous.previewRewind = async () => {
      entered.resolve();
      await release.promise;
      return { targetId: turnId, prompt: 'keep original turn', removedTurns: 1, files: [] };
    };

    const rewind = harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: 'replacement' });
    await entered.promise;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    const replacement = harness.sidebar.controller;
    release.resolve();
    await assert.rejects(rewind, /巻き戻し確認中に対象の会話が切り替わりました/);

    assert.notEqual(replacement, previous);
    assert.deepEqual(previous.snapshot().messages, before.messages);
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.deepEqual(runs, ['keep original turn']);
    assert.deepEqual(forks, []);
    assert.equal(window.warningMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('rewind stops after confirmation if a new front conversation was opened while the prompt was visible', async () => {
  resetVscode();
  const runs: string[] = [];
  const forks: string[] = [];
  const harness = withSession(async () => rewindSession(runs, forks));
  const promptShown = deferred<void>();
  const confirmation = deferred<string | undefined>();
  const originalWarning = window.showWarningMessage;
  window.showWarningMessage = () => {
    promptShown.resolve();
    return confirmation.promise;
  };
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep original turn' });
    const previous = harness.sidebar.controller;
    const before = previous.snapshot();
    const turnId = before.turns[0]?.id;
    assert.ok(turnId);
    previous.previewRewind = async () => ({ targetId: turnId, prompt: 'keep original turn', removedTurns: 1, files: [] });

    const rewind = harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: 'replacement' });
    await promptShown.promise;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    const replacement = harness.sidebar.controller;
    confirmation.resolve('Rewind and resend');
    await assert.rejects(rewind, /巻き戻し確認中に対象の会話が切り替わりました/);

    assert.notEqual(replacement, previous);
    assert.deepEqual(previous.snapshot().messages, before.messages);
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.deepEqual(runs, ['keep original turn']);
    assert.deepEqual(forks, []);
  } finally {
    confirmation.resolve(undefined);
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});

test('malformed permission and question payloads cannot grant access or crash the interaction route', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const permission = harness.sidebar.controller.interactions.requestPermission({ id: 'guarded-shell', title: 'Run command', detail: 'rm -rf temp', kind: 'shell' });
    await settle();
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 7, decision: 'allow-session' });
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-shell', decision: 'approve' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission?.id, 'guarded-shell');
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-shell', decision: 'deny' });
    assert.equal(await permission, 'deny');
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission, null);

    const answers = harness.sidebar.controller.interactions.requestAnswers({
      id: 'guarded-question', questions: [{ id: 'confirm', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
    });
    await settle();
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 'guarded-question', answers: 'invalid-shape' });
    assert.deepEqual(await answers, {});
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion, null);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('reviewFile rejects a path that escapes the workspace despite sharing its raw string prefix', async () => {
  resetVscode();
  const harness = openSidebar();
  const outsideFile = path.resolve(harness.workspacePath, '../outside-secret.txt');
  writeFileSync(outsideFile, 'synthetic secret file contents');
  const traversalPath = `${harness.workspacePath}/../outside-secret.txt`;
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: traversalPath, kind: 'update', previousText: 'before state' }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: traversalPath });

    assert.equal(commands.executed.some((entry) => entry.command === 'vscode.diff'), false);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'synthetic secret file contents');
    assert.equal(window.visibleEditors.length, 0);
    assert.equal(harness.sidebar.controller.snapshot().changes[0]?.previousText, 'before state');
  } finally {
    await close(harness);
  }
});

test('restoreSession uses the active workspace when a saved index entry has no cwd', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'legacy-session-without-cwd', title: 'Older session', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'sdk',
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: ProviderSessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: ProviderSessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });

    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.cwd, paths.workspacePath);
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.snapshot().selection.cwd, paths.workspacePath);
    assert.equal(sidebar.controller.sessionId(), summary.id);
  } finally {
    await close(harness);
  }
});

test('Cursor diagnostics distinguish an unauthenticated SDK status from a status request failure', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'not-logged-in' }) });

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /FAIL Cursor SDK auth\nnot-logged-in/);
    assert.match(report, /Backend\ncursor\/sdk/);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});

