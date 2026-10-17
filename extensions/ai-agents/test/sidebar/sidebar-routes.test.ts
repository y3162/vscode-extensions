import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, Selection, SendExtras, SessionSummary, TerminalRecord } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { commands, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness, type TestView } from '../support/vscode-harness.js';

interface RunCall {
  prompt: string;
  extras?: SendExtras;
  selection?: Selection;
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

function restoreReadyPlan(harness: Harness, id: string, revision: number): void {
  const state = harness.sidebar.controller.snapshot();
  state.plan = {
    phase: 'ready',
    revisions: [{ revision, createdAt: revision, source: 'assistant-text', markdown: `# Plan ${revision}` }],
    current: {
      id, revision, markdown: `# Plan ${revision}`, todos: [], source: 'assistant-text', createdAt: revision,
    },
  };
  harness.sidebar.controller.restoreSnapshot(state);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function openSidebarWithFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
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
    assert.deepEqual(sessions[0]?.modes, ['plan']);
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'plan');

    await harness.sidebar.handleMessage({ type: 'configure', network: true, webSearch: 'live' });
    assert.equal(sessions[0]?.disposed, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
    const saved = harness.context.workspaceState.get<Record<string, { network: boolean; webSearch: string; mode: string }>>('ai-agents.controls');
    assert.equal(saved?.codex?.network, true);
    assert.equal(saved?.codex?.webSearch, 'live');
    assert.equal(saved?.codex?.mode, 'plan');
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
    assert.deepEqual(harness.context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex')?.map((item) => item.id).sort(), ['backend-session', 'list-session']);

    session.failListSessions = new Error('synthetic listing failure');
    await harness.sidebar.handleMessage({ type: 'refreshSessions' });
    assert.deepEqual(harness.sidebar.controller.snapshot().sessions.map((item) => item.id).sort(), ['backend-session', 'list-session']);
    assert.ok(harness.output.lines.some((line) => line.includes('synthetic listing failure')));
  } finally {
    await close(harness);
  }
});

test('refreshSessions merges Cursor SDK store entries and preserves them if the store later fails', async () => {
  resetVscode();
  let fail = false;
  let receivedCwd = '';
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const storedSession: SessionSummary = {
    id: 'cursor-store-session', title: 'from local store', updatedAt: '2026-10-17T01:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const sidebar = new AgentsSidebar(paths.context as never, output as never, async (options) => {
    receivedCwd = options.cwd;
    if (fail) throw new Error('synthetic Cursor store failure');
    return [storedSession];
  });
  const harness: Harness = { ...paths, sidebar, output };
  const view = createView();
  try {
    await ready(sidebar, view);
    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: paths.workspacePath });
    await sidebar.handleMessage({ type: 'refreshSessions' });
    assert.equal(receivedCwd, paths.workspacePath);
    assert.deepEqual(sidebar.controller.snapshot().sessions.map((item) => item.id), ['cursor-store-session']);
    assert.deepEqual(harness.context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex')?.map((item) => item.id), ['cursor-store-session']);

    fail = true;
    await sidebar.handleMessage({ type: 'refreshSessions' });
    assert.deepEqual(sidebar.controller.snapshot().sessions.map((item) => item.id), ['cursor-store-session']);
    assert.ok(output.lines.some((line) => line.includes('synthetic Cursor store failure')));
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
    assert.equal(options?.backend, 'sdk');
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

    assert.ok(backgroundController.snapshot().sessions.some((item) => item.id === 'identity-thread' && item.backend === 'sdk'));
    assert.ok(harness.sidebar.controller.snapshot().sessions.some((item) => item.id === 'identity-thread'));
    const persisted = harness.context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex') ?? [];
    const saved = persisted.find((item) => item.id === 'identity-thread');
    assert.equal(saved?.backend, 'sdk');
    assert.ok(saved?.conversationId);
    assert.ok(saved?.cwd === harness.workspacePath);
  } finally {
    await close(harness);
  }
});

test('a stale model catalog request is discarded after a newer request replaces it', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    let releaseOld!: (models: Array<{ id: string; label: string }>) => void;
    const oldResult = new Promise<Array<{ id: string; label: string }>>((resolve) => { releaseOld = resolve; });
    let calls = 0;
    harness.sidebar.listAvailableModels = async () => {
      calls += 1;
      return calls === 1 ? oldResult : [{ id: 'new-model', label: 'New model' }];
    };

    const oldRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 21, refresh: true });
    const latestRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 22, refresh: true });
    await latestRequest;
    releaseOld([{ id: 'stale-model', label: 'Stale model' }]);
    await oldRequest;

    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.equal(catalogs.length, 1);
    assert.equal(catalogs[0]?.requestId, 22);
    assert.deepEqual((catalogs[0]?.models as Array<{ id: string }>).map((model) => model.id), ['new-model']);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 23 });
    assert.equal(calls, 2, 'a non-refresh request should use the catalog cache');
    assert.equal(view.messages.filter((message) => message.type === 'modelCatalog').at(-1)?.requestId, 23);
  } finally {
    await close(harness);
  }
});

test('a model catalog result is discarded after the selected provider changes mid-request', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  let release!: (models: Array<{ id: string; label: string }>) => void;
  const delayed = new Promise<Array<{ id: string; label: string }>>((resolve) => { release = resolve; });
  let started = false;
  harness.sidebar.listAvailableModels = async () => {
    started = true;
    return delayed;
  };
  try {
    await ready(harness.sidebar, view);
    const request = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 31, refresh: true });
    await waitFor(() => started, 'catalog request to start');
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    release([{ id: 'codex-result', label: 'Old provider model' }]);
    await request;
    assert.equal(view.messages.some((message) => message.type === 'modelCatalog' && message.requestId === 31), false);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});

test('model picker applies the active catalog item and releases picker state after acceptance', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const model: AgentModel = {
    id: 'picker-model', label: 'Picker model', aliases: ['picker-alias'], isDefault: true,
    defaultParams: [{ id: 'effort', value: 'high' }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await ready(harness.sidebar, view);
    const choosing = harness.sidebar.handleMessage({ type: 'chooseModel' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false && window.quickPicks.at(-1)?.items.length === 1, 'picker model');
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.matchOnDescription, true);
    assert.equal(picker.matchOnDetail, true);
    picker.selectedItems = [picker.items[0]!];
    picker.activate([picker.items[0]!]);
    assert.equal(harness.sidebar.isModelPickerReady(), true);
    assert.equal(harness.sidebar.isModelPickerReady('picker-model'), true);
    assert.equal(harness.sidebar.isModelPickerReady('other-model'), false);
    picker.accept();
    await choosing;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'picker-model');
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex, {
      model: 'picker-model', label: 'Picker model', hasDetails: false,
      modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.isModelPickerReady(), false);
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
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start' });
    await harness.sidebar.handleMessage({ type: 'configure', mode: 'plan' });

    assert.equal(session.disposed, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'plan');
    assert.equal(harness.context.workspaceState.get<Record<string, { mode: string }>>('ai-agents.controls')?.codex?.mode, 'plan');
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

test('Cursor model catalog cancels stale results, reports the current error, then caches a successful refresh', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  let calls = 0;
  let releaseStale!: (models: AgentModel[]) => void;
  const staleResult = new Promise<AgentModel[]>((resolve) => { releaseStale = resolve; });
  const freshModel: AgentModel = { id: 'cursor-fresh', label: 'Cursor fresh model' };
  harness.sidebar.listAvailableModels = async (selection, signal) => {
    calls += 1;
    assert.ok(selection);
    assert.equal(selection.provider, 'cursor');
    assert.ok(signal instanceof AbortSignal);
    if (calls === 1) return staleResult;
    if (calls === 2) throw new Error('synthetic Cursor catalog failure');
    return [freshModel];
  };
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });

    const staleRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 41, refresh: true });
    await waitFor(() => calls === 1, 'first Cursor catalog request');
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 42, refresh: true });
    releaseStale([{ id: 'cursor-stale', label: 'Stale Cursor model' }]);
    await staleRequest;

    const afterFailure = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.equal(afterFailure.length, 1);
    assert.equal(afterFailure[0]?.requestId, 42);
    assert.equal(afterFailure[0]?.status, 'error');
    assert.match(String(afterFailure[0]?.error), /synthetic Cursor catalog failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);

    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 43, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 44 });
    assert.equal(calls, 3, 'the unrefreshed request should use the successful Cursor cache');
    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.deepEqual(catalogs.map((message) => [message.requestId, message.status]), [[42, 'error'], [43, 'ready'], [44, 'ready']]);
    assert.deepEqual((catalogs.at(-1)?.models as Array<{ id: string }>).map((model) => model.id), ['cursor-fresh']);
  } finally {
    await close(harness);
  }
});

test('model parameter events preserve current settings for invalid input, stale lookup, and a busy conversation', async () => {
  resetVscode();
  const harness = openSidebar();
  const secondWorkspace = path.join(harness.root, 'second-workspace');
  mkdirSync(secondWorkspace);
  workspace.workspaceFolders?.push({ name: 'second', uri: Uri.file(secondWorkspace), index: 1 });
  const model: AgentModel = {
    id: 'model-with-effort', label: 'Model with effort',
    parameters: [{ id: 'effort', label: 'Effort', values: [
      { value: 'low', label: 'Low' }, { value: 'high', label: 'High' },
    ] }],
  };
  let secondWorkspaceLookup!: (models: AgentModel[]) => void;
  const delayedModels = new Promise<AgentModel[]>((resolve) => { secondWorkspaceLookup = resolve; });
  let lookupCount = 0;
  harness.sidebar.listAvailableModels = async (selection) => {
    lookupCount += 1;
    assert.ok(selection);
    return selection.cwd === secondWorkspace ? delayedModels : [model];
  };
  try {
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: '', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'unknown', value: 'high' });
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'unsupported' });
    assert.equal(lookupCount, 1);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);

    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'effort', value: 'high' }]);
    await harness.sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: secondWorkspace });
    const staleParameter = harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'low' });
    await waitFor(() => lookupCount === 2, 'parameter lookup for the second workspace');
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    secondWorkspaceLookup([model]);
    await staleParameter;
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, harness.workspacePath);
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);
  } finally {
    secondWorkspaceLookup([]);
    await close(harness);
  }

  resetVscode();
  const busyHarness = openSidebar();
  const session = fakeSession('busy-param-session');
  let releaseRun!: () => void;
  session.runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  installFakeFactory(busyHarness, () => session);
  let modelLookups = 0;
  busyHarness.sidebar.listAvailableModels = async () => { modelLookups += 1; return [model]; };
  try {
    const running = busyHarness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: busyHarness.workspacePath, prompt: 'long running turn' });
    await waitFor(() => session.runs.length === 1 && busyHarness.sidebar.controller.snapshot().busy, 'active turn');
    const selectionBefore = busyHarness.sidebar.controller.snapshot().selection;
    await assert.rejects(
      () => busyHarness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'high' }),
      /実行が終わってからモデルを選択してください/,
    );
    assert.equal(modelLookups, 0);
    assert.deepEqual(busyHarness.sidebar.controller.snapshot().selection, selectionBefore);
    releaseRun();
    await running;
    assert.equal(busyHarness.sidebar.controller.snapshot().busy, false);
  } finally {
    releaseRun();
    await close(busyHarness);
  }
});

test('enqueue while a turn is active retains a removable queue item and never sends it afterward', async () => {
  resetVscode();
  const harness = openSidebar();
  const session = fakeSession('queue-session');
  let release!: () => void;
  session.runGate = new Promise<void>((resolve) => { release = resolve; });
  installFakeFactory(harness, () => session);
  try {
    const active = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active turn' });
    await waitFor(() => session.runs.length === 1, 'active fixture run');
    await harness.sidebar.handleMessage({ type: 'enqueue', provider: 'codex', cwd: harness.workspacePath, prompt: 'queued turn', attachments: ['context.md'] });
    const queued = harness.sidebar.controller.snapshot().queue[0];
    assert.ok(queued);
    assert.equal(queued.text, 'queued turn');
    assert.deepEqual(queued.extras?.attachments, ['context.md']);

    await harness.sidebar.handleMessage({ type: 'removeQueued', id: queued.id });
    assert.equal(harness.sidebar.controller.snapshot().queue.length, 0);
    release();
    await active;
    assert.equal(session.runs.length, 1);
    assert.equal(harness.sidebar.controller.snapshot().queue.length, 0);
    assert.equal(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').some((message) => message.text === 'queued turn'), false);
  } finally {
    release?.();
    await close(harness);
  }
});

test('buildPlan applies a validated model selection and restores Plan mode after a failed build', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const session = fakeSession('build-session');
  installFakeFactory(harness, () => session);
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', mode: 'plan' });
    restoreReadyPlan(harness, 'plan-1', 1);
    await harness.sidebar.handleMessage({ type: 'setBuildParam', id: 'effort', value: 'high' });
    await harness.sidebar.handleMessage({
      type: 'buildPlan', planId: 'plan-1', revision: 1, modelId: 'fixture-model',
      modelParams: [{ id: 'effort', value: 'high' }, { id: 5, value: 'invalid' }], label: 'Fixture model',
    });
    assert.equal(session.models[0]?.model, 'fixture-model');
    assert.deepEqual(session.models[0]?.modelParams, [{ id: 'effort', value: 'high' }]);
    assert.match(session.runs[0]?.prompt ?? '', /Implement the following plan/);
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'implemented');
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'agent');
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.label, 'Fixture model');

    await harness.sidebar.handleMessage({ type: 'configure', mode: 'plan' });
    restoreReadyPlan(harness, 'plan-2', 2);
    session.failRun = new Error('synthetic build failure');
    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'plan-2', revision: 2, modelId: 'fixture-model' });
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'ready');
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'plan');
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'error' && message.text.includes('synthetic build failure')));
  } finally {
    await close(harness);
  }
});

test('Build model selection applies the canonical model only to the ready plan', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'build-model', label: 'Build model', aliases: ['build-alias'],
    defaultParams: [{ id: 'effort', value: 'high' }],
  };
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    await ready(harness.sidebar, createView());
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', mode: 'plan' });
    restoreReadyPlan(harness, 'build-model-plan', 3);
    const selectionBefore = harness.sidebar.controller.snapshot().selection;

    await harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'build-alias' });

    const plan = harness.sidebar.controller.snapshot().plan;
    assert.equal(plan.phase, 'ready');
    assert.equal(plan.build?.label, 'Build model');
    assert.deepEqual(plan.build?.selection, {
      ...selectionBefore, model: 'build-model', modelParams: [{ id: 'effort', value: 'high' }],
    });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selectionBefore);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
  } finally {
    await close(harness);
  }
});

test('a Build model result from an older Plan revision is discarded', async () => {
  resetVscode();
  const harness = openSidebar();
  let started = false;
  let release!: (models: AgentModel[]) => void;
  harness.sidebar.listAvailableModels = async () => {
    started = true;
    return new Promise<AgentModel[]>((resolve) => { release = resolve; });
  };
  try {
    await ready(harness.sidebar, createView());
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', mode: 'plan' });
    restoreReadyPlan(harness, 'build-stale-plan', 4);
    const pending = harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'stale-build-model' });
    await waitFor(() => started, 'Build model lookup');
    restoreReadyPlan(harness, 'build-stale-plan', 5);
    release([{ id: 'stale-build-model', label: 'Stale build model' }]);
    await pending;

    const plan = harness.sidebar.controller.snapshot().plan;
    assert.equal(plan.current?.revision, 5);
    assert.equal(plan.build, undefined);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
  } finally {
    release?.([]);
    await close(harness);
  }
});

test('model picker recovers from a list failure when the user refreshes', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = { id: 'retry-picker-model', label: 'Retry picker model' };
  let calls = 0;
  harness.sidebar.listAvailableModels = async () => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic catalog outage');
    return [model];
  };
  try {
    await ready(harness.sidebar, createView());
    const choosing = harness.sidebar.handleMessage({ type: 'chooseModel' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'failed picker load');
    const picker = window.quickPicks.at(-1)!;
    assert.deepEqual(picker.items, []);
    assert.match(picker.placeholder, /取得に失敗/);
    assert.ok(window.errorMessages.some((message) => message.includes('synthetic catalog outage')));

    picker.triggerButton();
    await waitFor(() => picker.busy === false && picker.items.length === 1, 'picker refresh');
    picker.selectedItems = [picker.items[0]!];
    picker.activate([picker.items[0]!]);
    picker.accept();
    await choosing;

    assert.equal(calls, 2);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'retry-picker-model');
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex?.model, 'retry-picker-model');
    assert.equal(picker.disposed, true);
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

test('a rejected build model restores Plan mode and persistence without committing the rejected model', async () => {
  resetVscode();
  const createdOptions: SessionOptions[] = [];
  const sessions = [fakeSession('rejected-build-model'), fakeSession('followup-plan-mode')];
  sessions[0]!.failSetModel = new Error('backend rejected build model');
  const harness = openSidebarWithFactory(async (options) => {
    createdOptions.push(options);
    return sessions[createdOptions.length - 1] ?? sessions[1]!;
  });
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', mode: 'plan' });
    restoreReadyPlan(harness, 'rejected-build', 1);
    const previousSelection = harness.sidebar.controller.snapshot().selection;

    await harness.sidebar.handleMessage({
      type: 'buildPlan', planId: 'rejected-build', revision: 1, modelId: 'must-not-commit', label: 'Rejected model',
    });

    assert.equal(sessions[0]?.models.length, 0);
    assert.equal(sessions[0]?.runs.length, 0);
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'ready');
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, previousSelection);
    assert.equal(latestShell<{ mode: string }>(view)?.mode, 'plan');
    assert.equal(harness.context.workspaceState.get<Record<string, { mode: string; backend: string }>>('ai-agents.controls')?.codex?.mode, 'plan');
    assert.equal(harness.context.workspaceState.get<Record<string, { model?: string; label?: string }>>('ai-agents.selectedModels')?.codex?.model, undefined);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'error' && message.text.includes('backend rejected build model')));

    await harness.sidebar.handleMessage({ type: 'newChat' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'continue in Plan mode' });
    assert.equal(createdOptions.length, 2);
    assert.equal(createdOptions[0]?.mode, 'agent', 'build temporarily requests Agent mode from the backend');
    assert.equal(createdOptions[1]?.mode, 'plan', 'the next conversation uses the restored Plan controller controls');
    assert.equal(harness.sidebar.controller.snapshot().selection.model, previousSelection.model);
    assert.equal(harness.context.workspaceState.get<Record<string, { model?: string }>>('ai-agents.selectedModels')?.codex?.model, undefined);
  } finally {
    await close(harness);
  }
});
