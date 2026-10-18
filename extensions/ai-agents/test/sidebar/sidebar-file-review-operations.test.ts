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

test('compact and supported review built-ins use the live Session APIs without sending duplicate chat turns', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('builtin-session');
  installFakeFactory(harness, () => session);
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'open session' });
    const userMessagesBefore = harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').length;

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/compact' });
    assert.equal(session.compactCalls, 1);
    assert.equal(session.runs.length, 1);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('コンテキストを圧縮しました')));

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/review' });
    assert.deepEqual(session.reviews, ['uncommitted']);
    assert.equal(session.runs.length, 1);
    assert.equal(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').length, userMessagesBefore + 1);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'reviewed by fixture'));

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/diagnostics inspect errors' });
    assert.match(session.runs[1]?.prompt ?? '', /inspect errors/);
    assert.match(session.runs[1]?.prompt ?? '', /No errors or warnings/);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/terminal inspect commands' });
    assert.match(session.runs[2]?.prompt ?? '', /inspect commands/);
    assert.match(session.runs[2]?.prompt ?? '', /VS Code/);
  } finally {
    await close(harness);
  }
});

test('openDiff is read-only without a baseline and revertFile refuses an unrecoverable change', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'unknown-baseline.txt');
  writeFileSync(file, 'leave untouched');
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: file, kind: 'update' }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: file });
    assert.equal(window.visibleEditors.at(-1)?.document.uri.fsPath, file);
    assert.equal(commands.executed.some((entry) => entry.command === 'vscode.diff'), false);
    await harness.sidebar.handleMessage({ type: 'openFile', path: file, line: 99, column: 0, endLine: 200 });
    const editor = window.visibleEditors.at(-1);
    assert.equal(editor?.selection?.start.line, 3);
    assert.equal(editor?.selection?.end.line, 3);
    assert.equal(editor?.selection?.end.character, 'line-4'.length);
    assert.equal(editor?.revealed.length, 1);
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'revertFile', path: file }), /変更前の内容が無いため/);
    assert.equal(readFileSync(file, 'utf8'), 'leave untouched');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('Reverted unknown-baseline.txt')), false);
  } finally {
    await close(harness);
  }
});

test('openDiff writes a safe workspace baseline without changing the file, and explicit revert restores it', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'reviewable.txt');
  writeFileSync(file, 'current user file contents');
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{
      path: file, kind: 'update', previousText: 'original baseline contents',
      diff: 'diff --git a/reviewable.txt b/reviewable.txt\n-old\n+current',
    }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: file });
    const diff = commands.executed.filter((entry) => entry.command === 'vscode.diff').at(-1);
    assert.ok(diff);
    const baseline = diff.args[0] as Uri;
    assert.ok(existsSync(baseline.fsPath));
    assert.equal(readFileSync(baseline.fsPath, 'utf8'), 'original baseline contents');
    assert.equal((diff.args[1] as Uri).fsPath, file);
    assert.equal(readFileSync(file, 'utf8'), 'current user file contents');

    await harness.sidebar.handleMessage({ type: 'openFile', path: file, line: 1 });
    assert.equal(window.visibleEditors.at(-1)?.document.uri.fsPath, file);
    assert.equal(readFileSync(file, 'utf8'), 'current user file contents');

    await harness.sidebar.handleMessage({ type: 'revertFile', path: file });
    assert.equal(readFileSync(file, 'utf8'), 'original baseline contents');
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('Reverted reviewable.txt')));
  } finally {
    await close(harness);
  }
});
