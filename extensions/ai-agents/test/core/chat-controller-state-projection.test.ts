import assert from 'node:assert/strict';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import { buildShell } from '../../src/view-state.js';

import { capabilitiesFor, defaultControls } from '../../src/capabilities.js';

import { emptyPlanState, type ChatState, type Selection, type TurnRecord } from '../../src/types.js';

const baseSelection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function displayStatus(extra: Partial<ChatState>, locale: 'en' | 'ja' = 'en'): string {
  return buildShell({
    state: state(extra), folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'Fixture', hasModelDetails: false,
    capabilities: capabilitiesFor('codex', 'sdk'), controls: defaultControls('codex', 'sdk'), locale,
    tokens: { permission: null, plan: null, question: null }, backends: { codex: 'sdk', cursor: 'sdk' },
  }).statusText;
}

function state(extra: Partial<ChatState> = {}): ChatState {
  return {
    selection: baseSelection, busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null, plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    ...extra,
  };
}

test('status labels cover both locales for cancellation and restoration', () => {
  assert.equal(displayStatus({ status: 'cancelling' }), 'Stopping…');
  assert.equal(displayStatus({ status: 'cancelling' }, 'ja'), '停止中…');
  assert.equal(displayStatus({ status: 'restoring' }), 'Restoring…');
  assert.equal(displayStatus({ status: 'restoring' }, 'ja'), '復元中…');
});

test('similar backend error events update one error row and preserve its first visible text', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'error-1', role: 'error', text: 'Backend: request failed' });
      emit({ id: 'error-2', role: 'error', text: 'request failed' });
      emit({ id: 'error-3', role: 'error', text: 'Backend detail: Backend: request failed' });
    },
    async dispose() {},
  }), () => {});

  await controller.send('produce repeated error detail');
  const errors = controller.snapshot().messages.filter((message) => message.role === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.text, 'Backend: request failed');
  await controller.dispose();
});

test('explicit auto-approval resolves once, while stale plan and question decisions preserve error status', async () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.setAutoApprove(true);
  assert.equal(await controller.interactions.requestPermission({ id: 'auto', title: 'Write file', detail: 'safe.txt', kind: 'write' }), 'allow-once');
  assert.equal(controller.snapshot().pendingPermission, null);

  controller.setAutoApprove(false);
  const planWait = controller.interactions.requestPlan({ id: 'plan', plan: 'Review', todos: [] });
  controller.setStatus('error');
  controller.resolvePlan('wrong-id', 'accepted');
  assert.equal(controller.snapshot().pendingPlan?.id, 'plan');
  controller.resolvePlan('plan', 'rejected');
  assert.equal(await planWait, 'rejected');
  assert.equal(controller.snapshot().status, 'error');

  const questionWait = controller.interactions.requestAnswers({ id: 'question', questions: [] });
  controller.setStatus('error');
  controller.resolveAnswers('question', { choice: ['safe'] });
  assert.deepEqual(await questionWait, { choice: ['safe'] });
  assert.equal(controller.snapshot().status, 'error');
  await controller.dispose();
});

test('restored background messages retain session origin and session totals suppress default-source request totals', async () => {
  let background!: (update: import('../../src/types.js').AgentUpdate) => void;
  const controller = new ChatController(baseSelection, async () => ({
    sessionId: 'background-thread',
    subscribeBackgroundUpdates(listener) { background = listener; return () => {}; },
    async run() {},
    async dispose() {},
  }), () => {});

  await controller.openSession();
  background({ id: 'child-1', role: 'status', text: 'Child started', meta: {
    type: 'subagent', subagent: { id: 'child', name: 'Child', status: 'running', background: true },
  } });
  background({ id: 'child-1', role: 'assistant', text: 'Child finished', meta: {
    type: 'subagent', subagent: { id: 'child', name: 'Child', status: 'completed', background: false },
  } });
  const childRows = controller.snapshot().messages.filter((message) => message.id === 'background-thread:child-1');
  assert.equal(childRows.length, 1);
  assert.equal(childRows[0]?.turnId, 'background-thread');
  assert.equal(childRows[0]?.text, 'Child finished');

  background({ id: 'session-total', role: 'status', text: '', meta: { type: 'usage', usage: {
    scope: 'session', inputTokens: 10, outputTokens: 2, totalTokens: 12,
  } } });
  background({ id: 'request-total', role: 'status', text: '', meta: { type: 'usage', usage: {
    scope: 'request', inputTokens: 900, outputTokens: 900, totalTokens: 1800,
  } } });
  assert.equal(controller.snapshot().usage?.totalTokens, 12);
  assert.equal(controller.snapshot().messages.some((message) => message.id.endsWith(':request-total')), false);
  await controller.dispose();
});;;;;
