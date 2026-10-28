import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import type { AgentModel, AgentSession, Selection, SendExtras, SessionSummary, TerminalRecord } from '../../src/types.js';

import { commands, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness, type TestView } from '../support/vscode-harness.js';

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

interface RunCall {
  prompt: string;
  extras?: SendExtras;
  selection?: Selection;
}

test('configure applies supported mode changes and resets a live session for execution-setting changes', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sessions: FakeSession[] = [];
  installFakeFactory(harness, () => {
    const session = fakeSession(`configure-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start' });
    await harness.sidebar.handleMessage({ type: 'configure', mode: 'plan' });
    assert.deepEqual(sessions[0]?.modes, []);
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'agent');

    await harness.sidebar.handleMessage({ type: 'configure', network: true, webSearch: 'live' });
    assert.equal(sessions[0]?.disposed, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
    const saved = harness.context.workspaceState.get<Record<string, { network: boolean; webSearch: string; mode: string }>>('ai-agents.controls');
    assert.equal(saved?.codex?.network, true);
    assert.equal(saved?.codex?.webSearch, 'live');
    assert.equal(saved?.codex?.mode, 'agent');
    assert.match(harness.sidebar.controller.snapshot().messages.at(-1)?.text ?? '', /新しい会話/);
  } finally {
    await close(harness);
  }
});

test('adding and removing additional directories persist settings and replace an active session', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sessions: FakeSession[] = [];
  installFakeFactory(harness, () => {
    const session = fakeSession(`directory-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const directory = path.join(harness.root, 'external-context');
  mkdirSync(directory);
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'first' });
    window.openDialogQueue.push([Uri.file(directory)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    assert.equal(sessions[0]?.disposed, 1);
    assert.deepEqual(latestShell<{ additionalDirectories: string[] }>(view)?.additionalDirectories, [directory]);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex?.additionalDirectories, [directory]);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'second' });
    window.openDialogQueue.push([Uri.file(directory)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: path.join(harness.root, 'not-configured') });
    assert.equal(sessions[1]?.disposed, 0, 'duplicate add and unknown remove leave the active session intact');
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'second'));
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: directory });
    assert.equal(sessions[1]?.disposed, 1);
    assert.deepEqual(latestShell<{ additionalDirectories: string[] }>(view)?.additionalDirectories, []);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex?.additionalDirectories, []);
  } finally {
    await close(harness);
  }
});

test('a backend that cannot change mode resets the live session while preserving the requested mode', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('mode-session');
  delete session.setMode;
  installFakeFactory(harness, () => session);
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'start' });
    await harness.sidebar.handleMessage({ type: 'configure', mode: 'plan' });

    assert.equal(session.disposed, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'plan');
    assert.equal(harness.context.workspaceState.get<Record<string, { mode: string }>>('ai-agents.controls')?.cursor?.mode, 'plan');
  } finally {
    await close(harness);
  }
});

test('configuration changes update only the active provider conversation after a provider switch', async () => {
  resetVscode();
  const harness = openSidebar();
  const session = fakeSession('config-background');
  installFakeFactory(harness, () => session);
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep background conversation' });
    const background = harness.sidebar.controller;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });

    workspace.configuration['ai-agents']!.autoApprove = true;
    workspace.fireConfiguration((section) => section === 'ai-agents.autoApprove');

    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().autoApprove, true);
    assert.equal(background.snapshot().selection.provider, 'codex');
    assert.equal(background.snapshot().autoApprove, false);
  } finally {
    await close(harness);
  }
});
