import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, PlanState } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('restoring a session shows the backend transcript and does not apply a local plan store', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
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
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return {
      sessionId,
      async loadTranscript(emit) {
        emit({ id: 'restored-user', role: 'user', text: 'resume planning', backendTurnId: 'turn-1' });
        emit({
          id: 'restored-plan', role: 'status', text: '# Backend plan', backendTurnId: 'turn-1', backendId: 'plan',
          meta: { type: 'plan', plan: { markdown: '# Backend plan', source: 'assistant-text', todos: [{ content: 'from the backend', status: 'pending' }] } },
        });
      },
      async run() {},
      async dispose() {},
    };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    sidebar.controller.replaceSessions([{
      id: sessionId, title: 'Saved plan', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', backend: 'cli', cwd: paths.workspacePath,
    }]);
    await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });

    const restored = sidebar.controller.snapshot();
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.resumeId, sessionId);
    assert.equal(restored.messages.find((message) => message.role === 'user')?.text, 'resume planning');
    assert.equal(restored.plan.draft?.markdown, '# Backend plan');
    assert.equal(restored.plan.current?.id, undefined);
    assert.notEqual(restored.plan.current?.id, 'saved-plan-document');
  } finally {
    await close(harness);
  }
});

test('a saved ready plan is restored only when the backend transcript has no plan', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
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
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (): Promise<AgentSession> => ({
    sessionId,
    async loadTranscript(emit) {
      emit({ id: 'restored-user', role: 'user', text: 'resume planning', backendTurnId: 'turn-1' });
    },
    async run() {},
    async dispose() {},
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    sidebar.controller.replaceSessions([{
      id: sessionId, title: 'Saved plan', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', backend: 'cli', cwd: paths.workspacePath,
    }]);
    await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });
    const restored = sidebar.controller.snapshot();
    assert.equal(restored.messages.find((message) => message.role === 'user')?.text, 'resume planning');
    assert.equal(restored.plan.phase, 'ready');
    assert.equal(restored.plan.current?.id, 'saved-plan-document');
    assert.equal(restored.plan.current?.restored, true);
    assert.equal(restored.plan.current?.markdown, '# Saved implementation plan');
  } finally {
    await close(harness);
  }
});
