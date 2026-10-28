import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { prepareHarnessRoot, type Harness, type HarnessPaths } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>, prepare?: (paths: HarnessPaths) => void): Harness {
  const paths = prepareHarnessRoot();
  prepare?.(paths);
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function seedHistory(paths: Pick<HarnessPaths, 'context' | 'workspacePath'>, id: string, sessionId: string): string {
  const directory = path.join(paths.context.storageUri.fsPath, 'history', 'v1');
  mkdirSync(directory, { recursive: true });
  const record = {
    version: 1, id, sessionId, updatedAt: '2026-10-18T00:00:00.000Z',
    controls: { mode: 'agent', sandbox: 'workspace-write', approval: 'on-request', backend: 'cli', network: false, webSearch: '', additionalDirectories: [] },
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'saved-user', role: 'user', text: 'other conversation' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: { phase: 'idle', revisions: [] }, turns: [], subagents: [], terminals: [],
    },
  };
  const file = path.join(directory, `${id}.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

test('clearing the current conversation drops its plan and its display snapshot', async () => {
  resetVscode();
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let otherFile = '';
  const harness = withSession(async () => ({
    sessionId: 'active-session',
    async run(prompt, _signal, emit) { emit({ id: 'answer', role: 'assistant', text: `answer: ${prompt}`, final: true, backendTurnId: 'turn-1' }); },
    async dispose() {},
  }), (paths) => {
    otherFile = seedHistory(paths, otherId, 'other-session');
    void paths.context.workspaceState.update('ai-agents.plans', {
      'active-session': { phase: 'idle', revisions: [] },
      'other-session': { phase: 'planning', revisions: [{ id: 'other-revision' }] },
    });
  });
  const directory = path.join(harness.context.storageUri.fsPath, 'history', 'v1');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active conversation' });
    await harness.sidebar.flushHistory();
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.json') && name !== path.basename(otherFile)), false);
    const conversations = path.join(directory, 'conversations');
    const saved = readdirSync(conversations).filter((name) => name.endsWith('.json'));
    assert.equal(saved.length, 1);
    assert.match(readFileSync(path.join(conversations, saved[0]!), 'utf8'), /active conversation/);
    harness.sidebar.controller.rememberSession({
      id: 'active-session', title: 'active conversation', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', backend: 'cli', cwd: harness.workspacePath,
    });
    harness.sidebar.controller.rememberSession({
      id: 'other-session', conversationId: otherId, title: 'other conversation', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', backend: 'cli', cwd: harness.workspacePath,
    });

    window.warningQueue.push({ value: '現在の会話' });
    await commands.handlers.get('ai-agents.clearLocalHistory')!();

    assert.equal(readdirSync(directory).includes(path.basename(otherFile)), true);
    assert.equal(readdirSync(conversations).some((name) => name.endsWith('.json')), false);
    assert.equal(harness.context.workspaceState.get<Record<string, { phase: string }>>('ai-agents.plans')?.['active-session'], undefined);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { phase: string }>>('ai-agents.plans')?.['other-session'], {
      phase: 'planning', revisions: [{ id: 'other-revision' }],
    });
    assert.ok(harness.sidebar.controller.snapshot().sessions.some((summary) => summary.id === 'other-session'));
    assert.equal(harness.context.workspaceState.get('ai-agents.sessionIndex'), undefined);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'other conversation'), false);
  } finally {
    await close(harness);
  }
});
