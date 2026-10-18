import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection, SendExtras, SessionSummary, TerminalRecord } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

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
    const image = { mimeType: 'image/png', data: 'aW1hZ2U=', name: 'queued.png' };
    await harness.sidebar.handleMessage({ type: 'enqueue', provider: 'codex', cwd: harness.workspacePath, prompt: 'queued turn', attachments: ['context.md'], images: [image] });
    const queued = harness.sidebar.controller.snapshot().queue[0];
    assert.ok(queued);
    assert.equal(queued.text, 'queued turn');
    assert.deepEqual(queued.extras?.attachments, ['context.md']);
    assert.deepEqual(queued.extras?.images, [image]);
    await harness.sidebar.flushHistory();
    const historyRoot = path.join(harness.root, 'storage', 'history', 'v1');
    const savedName = readdirSync(historyRoot).find((name) => name.endsWith('.json'));
    assert.ok(savedName, 'the active conversation should have a local history snapshot');
    const persisted = JSON.parse(readFileSync(path.join(historyRoot, savedName), 'utf8')) as { state: { queue: unknown } };
    assert.deepEqual(persisted.state.queue, [queued], 'queued text and images survive the persisted snapshot');

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
