import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import { defaultControls } from '../../src/capabilities.js';
import { emptyPlanState, type AgentSession } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, window } from '../support/vscode-stub.js';
import { prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('an empty backend transcript shows the display snapshot, and a backend transcript wins on text', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const directory = path.join(paths.context.storageUri.fsPath, 'history', 'v1', 'conversations');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
    version: 1, id, sessionId: 'kept-session', updatedAt: '2026-10-18T00:00:00.000Z',
    controls: defaultControls('codex', 'cli'),
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'saved-user', role: 'user', text: 'local display' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: emptyPlanState(),
      turns: [{ id: 'turn-1', startedAt: 1, status: 'running', waitMs: 0, mode: 'agent', model: '', intent: 'chat' }],
      subagents: [], terminals: [],
    },
  }));
  const resumed: string[] = [];
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions): Promise<AgentSession> => {
    if (options.resumeId) resumed.push(options.resumeId);
    return {
      sessionId: 'kept-session',
      async loadTranscript() {},
      async run() {},
      async dispose() {},
    };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.flushHistory();
    assert.ok(sidebar.controller.snapshot().sessions.some((session) => session.id === 'kept-session'));
    await sidebar.handleMessage({ type: 'restoreSession', id: 'kept-session' });
    const restored = sidebar.controller.snapshot();
    assert.deepEqual(resumed, ['kept-session']);
    assert.equal(restored.messages.find((message) => message.role === 'user')?.text, 'local display');
    assert.equal(restored.turns[0]?.status, 'unknown');
  } finally {
    await close(harness);
  }

  resetVscode();
  const again = prepareHarnessRoot();
  const againDir = path.join(again.context.storageUri.fsPath, 'history', 'v1', 'conversations');
  mkdirSync(againDir, { recursive: true });
  writeFileSync(path.join(againDir, `${id}.json`), JSON.stringify({
    version: 1, id, sessionId: 'kept-session', updatedAt: '2026-10-18T00:00:00.000Z',
    controls: defaultControls('codex', 'cli'),
    state: {
      selection: { provider: 'codex', cwd: again.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'saved-user', role: 'user', text: 'local display' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    },
  }));
  const second = new AgentsSidebar(again.context as never, output as never, (async (): Promise<AgentSession> => ({
    sessionId: 'kept-session',
    async loadTranscript(emit) {
      emit({ id: 'backend-user', role: 'user', text: 'backend display', backendTurnId: 'turn-9' });
    },
    async run() {},
    async dispose() {},
  })) as never);
  const secondHarness: Harness = { ...again, sidebar: second, output };
  try {
    await second.flushHistory();
    await second.handleMessage({ type: 'restoreSession', id: 'kept-session' });
    const texts = second.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.text);
    assert.deepEqual(texts, ['backend display']);
  } finally {
    await close(secondHarness);
  }
});

test('a display snapshot without a backend session id is not resumed', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const directory = path.join(paths.context.storageUri.fsPath, 'history', 'v1', 'conversations');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
    version: 1, id, updatedAt: '2026-10-18T00:00:00.000Z',
    controls: defaultControls('codex', 'cli'),
    state: {
      selection: { provider: 'codex', cwd: paths.workspacePath, model: '' }, busy: false,
      messages: [{ id: 'saved-user', role: 'user', text: 'display only' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    },
  }));
  const output = window.createOutputChannel('AI Agents');
  let opened = 0;
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (): Promise<AgentSession> => {
    opened += 1;
    return { sessionId: 'should-not-open', async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.flushHistory();
    await sidebar.handleMessage({ type: 'restoreSession', id });
    assert.equal(opened, 0);
    const messages = sidebar.controller.snapshot().messages;
    assert.equal(messages.some((message) => message.text === 'display only'), true);
    assert.equal(messages.some((message) => /display-only/i.test(message.text)), true);
  } finally {
    await close(harness);
  }
});
