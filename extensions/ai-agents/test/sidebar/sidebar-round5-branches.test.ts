import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, Selection, SessionSummary } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { commands, resetVscode, window } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

function trackedSession(id: string, runs: string[], onCreate?: (options: SessionOptions) => void): (options: SessionOptions) => Promise<AgentSession> {
  return async (options) => {
    onCreate?.(options);
    return {
      sessionId: id,
      async run(prompt, _signal, emit) {
        runs.push(prompt);
        emit({ id: `${id}-answer-${runs.length}`, role: 'assistant', text: `answer: ${prompt}`, final: true });
      },
      async dispose() {},
    };
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('send from a known background conversation is ignored after the user starts a new chat', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(trackedSession('background-route-session', runs));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'background history' });
    const background = harness.sidebar.controller;
    const backgroundConversationId = (view.messages.filter((message) => message.type === 'state').at(-1)?.shell as { conversationId?: string } | undefined)?.conversationId;
    assert.ok(backgroundConversationId);

    await harness.sidebar.newChat();
    assert.notEqual(harness.sidebar.controller, background);
    const frontBefore = harness.sidebar.controller.snapshot();
    const backgroundBefore = background.snapshot();
    await harness.sidebar.handleMessage({
      type: 'send', conversationId: backgroundConversationId,
      provider: 'codex', cwd: harness.workspacePath, prompt: 'must stay in the background draft',
    });

    assert.deepEqual(runs, ['background history']);
    assert.deepEqual(harness.sidebar.controller.snapshot(), frontBefore);
    assert.deepEqual(background.snapshot(), backgroundBefore);
  } finally {
    await close(harness);
  }
});

test('a pending select cannot send into a conversation after newChat changes the front controller', async () => {
  resetVscode();
  const runs: string[] = [];
  let factoryCalls = 0;
  const harness = withFactory(async (options) => {
    factoryCalls += 1;
    return trackedSession(`race-session-${factoryCalls}`, runs)(options);
  });
  try {
    const previous = harness.sidebar.controller.snapshot();
    previous.messages = [{ id: 'retained-user', role: 'user', text: 'retained in previous conversation' }];
    harness.sidebar.controller.restoreSnapshot(previous);
    const previousController = harness.sidebar.controller;
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalSelect = previousController.select.bind(previousController);
    previousController.select = async (selection) => {
      entered.resolve();
      await release.promise;
      await originalSelect(selection);
    };

    const sending = harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must not escape the old controller',
    });
    await entered.promise;
    await harness.sidebar.newChat();
    const front = harness.sidebar.controller;
    assert.notEqual(front, previousController);
    release.resolve();
    await sending;

    assert.deepEqual(runs, []);
    assert.equal(factoryCalls, 0);
    assert.equal(front.snapshot().messages.length, 0);
    assert.equal(front.snapshot().selection.provider, 'codex');
    assert.equal(previousController.snapshot().messages[0]?.text, 'retained in previous conversation');
  } finally {
    await close(harness);
  }
});

test('model aliases resolve through one cached catalog and preserve the canonical model label', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'canonical-model', label: 'Canonical model', aliases: ['short-alias'],
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  let lookups = 0;
  harness.sidebar.listAvailableModels = async () => { lookups += 1; return [model]; };
  try {
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 51, refresh: true });
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'short-alias' });
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'short-alias' });

    assert.equal(lookups, 1, 'selection reuses the catalog returned by the explicit refresh');
    assert.equal(harness.sidebar.controller.snapshot().selection.model, model.id);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.model, model.id);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.label, model.label);

    const before = harness.sidebar.controller.snapshot().selection;
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'effort', value: 'unknown-value' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, before);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('reviewChanges skips paths outside the workspace and changes without a saved baseline', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [
      { path: '../outside.txt', kind: 'update', previousText: 'must not be exposed' },
      { path: 'no-baseline.txt', kind: 'update' },
      { path: 'patch', kind: 'update', previousText: 'synthetic protocol patch' },
    ];
    harness.sidebar.controller.restoreSnapshot(state);
    commands.executed.length = 0;

    await harness.sidebar.handleMessage({ type: 'reviewChanges' });

    assert.equal(commands.executed.some(({ command }) => command === 'vscode.changes' || command === 'vscode.diff'), false);
    assert.deepEqual(harness.sidebar.controller.snapshot().changes, state.changes);
    assert.equal(window.visibleEditors.length, 0);
  } finally {
    await close(harness);
  }
});

test('restoreSession ignores unknown IDs and the current session without constructing duplicates', async () => {
  resetVscode();
  const runs: string[] = [];
  let factoryCalls = 0;
  let summary: SessionSummary | undefined;
  const harness = withFactory(trackedSession('restore-known-session', runs, (options) => {
    factoryCalls += 1;
    options.onIdentity?.({
      id: 'restore-known-session', title: 'Known session', updatedAt: new Date().toISOString(),
      provider: 'codex', cwd: harness.workspacePath,
    });
  }));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'saved session' });
    const controller = harness.sidebar.controller;
    const initialMessages = controller.snapshot().messages;
    const initialId = controller.sessionId();
    summary = controller.snapshot().sessions.find((item) => item.id === initialId);
    assert.ok(summary);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: 'unknown-session-id' });
    assert.equal(harness.sidebar.controller, controller);
    assert.equal(factoryCalls, 1);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: initialId });
    assert.equal(harness.sidebar.controller, controller);
    assert.equal(controller.sessionId(), initialId);
    assert.deepEqual(controller.snapshot().messages, initialMessages);
    assert.equal(factoryCalls, 1);
    assert.ok(summary);
  } finally {
    await close(harness);
  }
});
