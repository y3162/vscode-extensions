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

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

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
    controls: { mode: 'plan', sandbox: 'workspace-write', approval: 'on-request', backend: 'cli', network: false, webSearch: '', additionalDirectories: [] },
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'restored-user', role: 'user', text: 'resume planning' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: { phase: 'idle', revisions: [] }, turns: [], subagents: [], terminals: [],
    },
  };
  writeFileSync(path.join(historyDirectory, `${conversationId}.json`), JSON.stringify(record));
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions): Promise<AgentSession> => {
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
