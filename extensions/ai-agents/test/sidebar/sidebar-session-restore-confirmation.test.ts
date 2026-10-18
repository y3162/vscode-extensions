import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession } from '../../src/types.js';

import type { SavedConversation } from '../../src/history-store.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('an assistant-only restored conversation requires confirmation before replacing its model session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const conversationId = '18181818-1818-4181-8181-181818181818';
  const sessionId = 'round18-assistant-only-session';
  const saved: SavedConversation = {
    version: 1,
    id: conversationId,
    sessionId,
    updatedAt: '2026-10-18T00:00:00.000Z',
    controls: { mode: 'agent', sandbox: 'workspace-write', approval: 'never', backend: 'sdk', network: false, webSearch: '', additionalDirectories: [] },
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: 'restored-model' },
      busy: false,
      messages: [{ id: 'round18-assistant-answer', role: 'assistant', text: 'A saved assistant-only response.' }],
      queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [], autoApprove: false,
      pendingPermission: null, pendingPlan: null, pendingQuestion: null, plan: { phase: 'idle', revisions: [] },
      turns: [], subagents: [], terminals: [],
    },
  };
  const historyDirectory = path.join(paths.context.storageUri.fsPath, 'history', 'v1');
  mkdirSync(historyDirectory, { recursive: true });
  writeFileSync(path.join(historyDirectory, `${conversationId}.json`), JSON.stringify(saved));
  const sessionOptions: SessionOptions[] = [];
  let disposed = 0;
  const restoredSession: AgentSession = {
    sessionId,
    async run() {},
    async dispose() { disposed += 1; },
  };
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions) => {
    sessionOptions.push(options);
    return restoredSession;
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const replacement: AgentModel = { id: 'round18-replacement-model', label: 'Replacement model' };
  sidebar.listAvailableModels = async () => [replacement];

  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });
    const original = sidebar.controller;
    assert.deepEqual(original.snapshot().messages.map(({ role, text }) => ({ role, text })), [
      { role: 'assistant', text: 'A saved assistant-only response.' },
    ]);
    assert.equal(original.sessionId(), sessionId);
    assert.equal(sessionOptions[0]?.resumeId, sessionId);

    await sidebar.handleMessage({ type: 'setModel', modelId: replacement.id });
    assert.match(window.warningMessages.at(-1) ?? '', /new session/i, 'an assistant-only transcript still requires user confirmation');
    assert.equal(sidebar.controller, original);
    assert.equal(original.snapshot().selection.model, 'restored-model');
    assert.equal(original.snapshot().messages.length, 1, 'cancelling keeps the restored assistant answer visible');
    assert.equal(original.sessionId(), sessionId);
    assert.equal(disposed, 0, 'cancelling leaves the restored backend session alive');
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);

    window.warningQueue.push({ value: 'Start new session' });
    await sidebar.handleMessage({ type: 'setModel', modelId: replacement.id });

    assert.equal(window.warningMessages.length, 2);
    assert.equal(sidebar.controller, original);
    assert.equal(original.snapshot().selection.model, replacement.id);
    assert.deepEqual(original.snapshot().messages, [], 'accepting the confirmation clears the old assistant-only transcript');
    assert.equal(original.hasSession(), false);
    assert.equal(disposed, 1, 'the old backend session is disposed exactly once after confirmation');
    assert.deepEqual(
      harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex,
      { model: replacement.id, label: replacement.label, hasDetails: false },
    );
  } finally {
    await close(harness);
  }
});
