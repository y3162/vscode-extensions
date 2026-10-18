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

function latestShell<T extends object>(view: TestView): T | undefined {
  return view.messages.filter((message) => message.type === 'state').at(-1)?.shell as T | undefined;
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

test('send and attach messages preserve submitted content and select the active file context', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('send-session');
  installFakeFactory(harness, () => session);
  const file = path.join(harness.workspacePath, 'active file.ts');
  writeFileSync(file, 'const value = 1;');
  try {
    await ready(harness.sidebar, view);
    window.activeTextEditor = {
      document: {
        uri: Uri.file(file), getText: () => 'const value = 1;', lineCount: 1, lineAt: () => ({ text: 'const value = 1;' }),
      },
      selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
    await harness.sidebar.handleMessage({ type: 'attach', kind: 'unknown' });
    const inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'File');
    assert.equal(inserted?.text, '@"active file.ts" ');

    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '  inspect this  ',
      attachments: ['  active.ts  ', '', 4, 'n'.repeat(250)],
    });
    assert.equal(session.runs.length, 1);
    assert.equal(session.runs[0]?.prompt, 'inspect this');
    assert.deepEqual(session.runs[0]?.extras, {
      displayText: '  inspect this  ',
      attachments: ['active.ts', 'n'.repeat(200)],
    });
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.final));
    assert.equal(harness.sidebar.controller.snapshot().turns.at(-1)?.status, 'completed');
    assert.ok(harness.output.lines.some((line) => line.includes(' start')));
    assert.ok(harness.output.lines.some((line) => line.includes('idle')));
    assert.equal(readFileSync(file, 'utf8'), 'const value = 1;');
  } finally {
    await close(harness);
  }
});

test('the registered Webview listener forwards successful messages and reports rejected requests', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    view.receive({ type: 'logs' });
    await waitFor(() => harness.output.shown, 'logs command from webview');

    view.receive({ type: 'send', provider: 'unknown-provider', cwd: harness.workspacePath, prompt: 'must be rejected' });
    await waitFor(() => window.errorMessages.some((message) => message.includes('エージェント設定が不正です')), 'webview error forwarding');
    assert.ok(harness.output.lines.some((line) => line.includes('エージェント設定が不正です')));
    assert.ok(view.messages.some((message) => message.type === 'error' && String(message.text).includes('エージェント設定が不正です')));
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
  } finally {
    await close(harness);
  }
});

test('terminal routes update the owning conversation and tolerate a front conversation without a live session', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('terminal-session');
  session.terminals = [{ processId: 'process-1', command: 'long-running', output: 'already running\n', status: 'running' }];
  installFakeFactory(harness, () => session);
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start' });
    const oldConversationId = latestShell<{ conversationId: string }>(view)?.conversationId;
    assert.ok(oldConversationId);
    await harness.sidebar.handleMessage({ type: 'openTerminal', conversationId: oldConversationId, processId: 'process-1' });
    const terminal = window.terminals.at(-1);
    assert.ok(terminal);
    assert.equal(terminal.shown, 1);
    const pty = (terminal.options as { pty: { open(): void } }).pty;
    pty.open();

    await harness.sidebar.handleMessage({ type: 'terminateTerminal', conversationId: oldConversationId, processId: 'process-1' });
    assert.deepEqual(session.terminated, ['process-1']);
    assert.deepEqual(harness.sidebar.controller.snapshot().terminals, []);

    await harness.sidebar.newChat();
    const stateCountBeforeNoSessionTermination = view.messages.filter((message) => message.type === 'state').length;
    await harness.sidebar.handleMessage({ type: 'terminateTerminal', processId: 'process-1' });
    assert.deepEqual(session.terminated, ['process-1']);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    const statesAfterNoSessionTermination = view.messages.filter((message) => message.type === 'state');
    assert.ok(statesAfterNoSessionTermination.length > stateCountBeforeNoSessionTermination);
    assert.deepEqual((statesAfterNoSessionTermination.at(-1)?.shell as { terminals: unknown[] } | undefined)?.terminals, []);
  } finally {
    await close(harness);
  }
});

test('interaction message routes reject a stale token and accept the current decision', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    const permission = harness.sidebar.controller.interactions.requestPermission({ id: 'guarded-permission', title: 'Write', detail: 'file.txt', kind: 'write' });
    await settle();
    const token = latestShell<{ permission: { token: string } | null }>(view)?.permission?.token;
    assert.ok(token);
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-permission', decision: 'deny', token: 'stale-token' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission?.id, 'guarded-permission');
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-permission', decision: 'allow-once', token });
    assert.equal(await permission, 'allow-once');
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission, null);

    const plan = harness.sidebar.controller.interactions.requestPlan({ id: 'guarded-plan', plan: '# Keep pending', todos: [] });
    await settle();
    const planToken = latestShell<{ plan: { token: string } | null }>(view)?.plan?.token;
    assert.ok(planToken);
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'guarded-plan', decision: 'rejected', token: 'stale-token' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan?.id, 'guarded-plan');
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'guarded-plan', decision: 'accepted', token: planToken });
    assert.equal(await plan, 'accepted');
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan, null);
  } finally {
    await close(harness);
  }
});

test('retrying a saved message with missing attachment data stays blocked until attachments are supplied again', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('retry-session');
  const note = path.join(harness.workspacePath, 'notes.txt');
  writeFileSync(note, 'saved attachment file');
  installFakeFactory(harness, () => session);
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.messages = [{ id: 'saved-user', role: 'user', text: 'retry this task', attachments: ['notes.txt'] }];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'saved-user' });
    assert.deepEqual(view.messages.filter((message) => message.type === 'retryPrepared').at(-1)?.attachments, ['notes.txt']);

    await assert.rejects(
      () => harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retry this task' }),
      /添付を再指定してから再送してください/,
    );
    assert.equal(session.runs.length, 0);
    assert.deepEqual(harness.sidebar.controller.snapshot().messages.map((message) => message.id), ['saved-user']);
    assert.equal(readFileSync(note, 'utf8'), 'saved attachment file');

    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retry this task', attachments: ['notes.txt'],
    });
    assert.equal(session.runs.length, 1);
    assert.equal(session.runs[0]?.extras?.retryOf, 'saved-user');
    assert.deepEqual(session.runs[0]?.extras?.attachments, ['notes.txt']);
    assert.deepEqual(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.id), ['saved-user']);
  } finally {
    await close(harness);
  }
});
