import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection, SendExtras, SessionSummary, TerminalRecord } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

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

function openSidebarWithFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

interface RunCall {
  prompt: string;
  extras?: SendExtras;
  selection?: Selection;
}

test('refreshSessions merges backend results and retains existing sessions when listing fails', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('list-session');
  installFakeFactory(harness, () => session);
  const backendSession: SessionSummary = {
    id: 'backend-session', title: 'from fake backend', updatedAt: '2026-10-17T00:00:00.000Z',
    provider: 'codex', cwd: harness.workspacePath,
  };
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start' });
    session.sessions = [backendSession];
    await harness.sidebar.handleMessage({ type: 'refreshSessions' });
    assert.deepEqual(harness.sidebar.controller.snapshot().sessions.map((item) => item.id).sort(), ['backend-session', 'list-session']);
    assert.equal(harness.context.workspaceState.get('ai-agents.sessionIndex'), undefined);

    session.failListSessions = new Error('synthetic listing failure');
    await harness.sidebar.handleMessage({ type: 'refreshSessions' });
    assert.deepEqual(harness.sidebar.controller.snapshot().sessions.map((item) => item.id).sort(), ['backend-session', 'list-session']);
    assert.ok(harness.output.lines.some((line) => line.includes('synthetic listing failure')));
  } finally {
    await close(harness);
  }
});

test('the normal controller factory passes execution controls and records background session identity safely', async () => {
  resetVscode();
  let options: SessionOptions | undefined;
  const session = fakeSession('factory-session');
  const harness = openSidebarWithFactory(async (next) => {
    options = next;
    return session;
  });
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start provider session' });
    assert.equal(options?.provider, 'codex');
    assert.equal(options?.cwd, harness.workspacePath);
    assert.equal(options?.backend, 'cli');
    assert.equal(options?.sandbox, 'workspace-write');
    assert.equal(options?.approval, 'never');
    assert.equal(options?.codexPath, '/usr/bin/false');
    assert.equal(options?.agentPath, '/usr/bin/false');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.ok(options?.interactions);
    assert.equal(typeof options?.onIdentity, 'function');

    const backgroundController = harness.sidebar.controller;
    await harness.sidebar.newChat();
    const summary: SessionSummary = {
      id: 'identity-thread', title: 'identified background thread', updatedAt: '2026-10-17T02:00:00.000Z',
      provider: 'codex', cwd: harness.workspacePath,
    };
    options?.onIdentity?.(summary);
    await settle();

    assert.ok(backgroundController.snapshot().sessions.some((item) => item.id === 'identity-thread' && item.backend === 'cli'));
    const saved = harness.sidebar.controller.snapshot().sessions.find((item) => item.id === 'identity-thread');
    assert.equal(saved?.backend, 'cli');
    assert.ok(saved?.conversationId);
    assert.ok(saved?.cwd === harness.workspacePath);
    assert.equal(harness.context.workspaceState.get('ai-agents.sessionIndex'), undefined);
  } finally {
    await close(harness);
  }
});

test('restoreSession refocuses an existing live conversation without creating a second backend session', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sessions: FakeSession[] = [];
  installFakeFactory(harness, () => {
    const session = fakeSession('restorable-live-session');
    sessions.push(session);
    return session;
  });
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep this session' });
    const existingController = harness.sidebar.controller;
    const existingId = latestShell<{ conversationId: string }>(view)?.conversationId;
    assert.ok(existingId);
    await harness.sidebar.newChat();
    assert.notEqual(harness.sidebar.controller, existingController);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: 'restorable-live-session' });
    assert.equal(harness.sidebar.controller, existingController);
    assert.equal(sessions.length, 1);
    assert.equal(latestShell<{ conversationId: string }>(view)?.conversationId, existingId);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this session'));
  } finally {
    await close(harness);
  }
});

test('newChat clears a stale folder selection when the workspace closes', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    workspace.workspaceFolders = [];
    await harness.sidebar.handleMessage({ type: 'newChat' });
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, '');
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
  } finally {
    await close(harness);
  }
});

test('the background session limit rejects a new send while preserving an existing queued item', async () => {
  resetVscode();
  workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
  const createdSessions: FakeSession[] = [];
  const session = fakeSession('limited-session');
  let releaseRun!: () => void;
  session.runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const harness = openSidebarWithFactory(async () => {
    const created = createdSessions.length === 0 ? session : fakeSession(`unexpected-${createdSessions.length}`);
    createdSessions.push(created);
    return created;
  });
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    const activeSend = harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active limited turn',
    });
    await waitFor(() => session.runs.length === 1 && harness.sidebar.controller.snapshot().busy, 'limited active turn');

    await harness.sidebar.handleMessage({
      type: 'enqueue', provider: 'codex', cwd: harness.workspacePath, prompt: 'preserve this queued turn',
    });
    const queued = harness.sidebar.controller.snapshot().queue[0];
    assert.ok(queued);
    const activeController = harness.sidebar.controller;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    const idleController = harness.sidebar.controller;
    assert.notEqual(idleController, activeController);

    await assert.rejects(
      () => harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must not start' }),
      /同時に実行できる会話の上限/,
    );
    assert.equal(harness.sidebar.controller, idleController);
    assert.equal(idleController.snapshot().busy, false);
    assert.equal(idleController.snapshot().messages.some((message) => message.role === 'user'), false);
    assert.deepEqual(activeController.snapshot().queue.map((item) => [item.id, item.text]), [[queued.id, 'preserve this queued turn']]);
    assert.equal(createdSessions.length, 1, 'the capped send must not create a second backend session');
    assert.equal(session.runs.length, 1);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: session.sessionId });
    assert.equal(harness.sidebar.controller, activeController);
    await harness.sidebar.handleMessage({ type: 'removeQueued', id: queued.id });
    assert.equal(activeController.snapshot().queue.length, 0);
    releaseRun();
    await activeSend;
    assert.equal(session.runs.length, 1, 'the preserved item was explicitly removed and never started');
  } finally {
    releaseRun();
    await close(harness);
  }
});
