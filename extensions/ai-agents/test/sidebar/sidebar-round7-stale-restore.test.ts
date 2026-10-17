import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate, PlanState } from '../../src/types.js';
import type { SavedConversation } from '../../src/history-store.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, window } from '../support/vscode-stub.js';
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

test('a model lookup that completes after newChat cannot apply to the replacement conversation', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'stale-model-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: 'stale-model-answer', role: 'assistant', text: 'old conversation answer', final: true });
    },
    async dispose() {},
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const entered = deferred<void>();
  const result = deferred<AgentModel[]>();
  sidebar.listAvailableModels = async () => {
    entered.resolve();
    return result.promise;
  };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'keep this conversation isolated' });
    const previous = sidebar.controller;
    const pending = sidebar.handleMessage({ type: 'setModel', modelId: 'late-model' });
    await entered.promise;
    await sidebar.handleMessage({ type: 'newChat' });
    const replacement = sidebar.controller;
    assert.notEqual(replacement, previous);

    result.resolve([{ id: 'late-model', label: 'Late model' }]);
    await pending;

    assert.equal(replacement.snapshot().selection.model, '');
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.equal(previous.snapshot().selection.model, '');
    assert.ok(previous.snapshot().messages.some((message) => message.text === 'keep this conversation isolated'));
    assert.equal(paths.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    result.resolve([]);
    await close(harness);
  }
});

test('restoring a saved session reapplies its persisted current Plan after opening the backend session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionId = 'saved-plan-session';
  const plan: PlanState = {
    phase: 'ready',
    revisions: [{ revision: 2, createdAt: 20, source: 'assistant-text', markdown: '# Saved implementation plan' }],
    current: {
      id: 'saved-plan-document', revision: 2, markdown: '# Saved implementation plan',
      todos: [{ content: 'preserve the plan', status: 'pending' }], source: 'assistant-text', createdAt: 20,
    },
  };
  await paths.context.workspaceState.update('ai-agents.plans', { [sessionId]: plan });
  const historyDirectory = path.join(paths.context.storageUri.fsPath, 'history', 'v1');
  mkdirSync(historyDirectory, { recursive: true });
  const record: SavedConversation = {
    version: 1,
    id: conversationId,
    sessionId,
    updatedAt: '2026-10-18T00:00:00.000Z',
    controls: { mode: 'plan', sandbox: 'workspace-write', approval: 'on-request', backend: 'sdk', network: false, webSearch: '', additionalDirectories: [] },
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'restored-user', role: 'user', text: 'resume planning' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: { phase: 'idle', revisions: [] }, turns: [], subagents: [], terminals: [],
    },
  };
  writeFileSync(path.join(historyDirectory, `${conversationId}.json`), JSON.stringify(record));
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return {
      sessionId,
      async run() {},
      async dispose() {},
    };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });

    const restored = sidebar.controller.snapshot();
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.resumeId, sessionId);
    assert.equal(restored.messages[0]?.text, 'resume planning');
    assert.equal(restored.plan.phase, 'ready');
    assert.equal(restored.plan.current?.id, 'saved-plan-document');
    assert.deepEqual(restored.plan.current?.todos, [{ content: 'preserve the plan', status: 'pending' }]);
  } finally {
    await close(harness);
  }
});

test('terminal open and terminate routes ignore a missing processId without touching session state', async () => {
  resetVscode();
  const harness = openSidebar();
  const before = harness.sidebar.controller.snapshot();
  try {
    await harness.sidebar.handleMessage({ type: 'openTerminal' });
    await harness.sidebar.handleMessage({ type: 'terminateTerminal' });

    assert.deepEqual(harness.sidebar.controller.snapshot(), before);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(window.terminals.length, 0);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
