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

test('snapshot restoration rejects malformed queued requests and keeps safe optional fields', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const saved = state({ queue: [
    null, [], { id: 3, text: 'bad id' }, { id: 'too-long', text: 'x'.repeat(100001) },
    { id: 'bad extras', text: 'valid text', extras: [] },
    { id: 'empty', text: ' ' },
    { id: 'bad image', text: 'keep?', extras: { images: [{ mimeType: 'image/png', data: 'invalid?' }] } },
    { id: 'safe', text: 'hello', extras: { retryOf: 'r', displayText: 'Shown', attachments: ['a', 2, 'b'] } },
  ] as never });
  controller.restoreSnapshot(saved);
  const restored = controller.snapshot();
  assert.deepEqual(restored.queue, [{ id: 'safe', text: 'hello', extras: { retryOf: 'r', displayText: 'Shown', attachments: ['a', 'b'] } }]);
  assert.match(restored.messages.at(-1)?.text ?? '', /画像を再添付/);
});

test('snapshot restoration bounds child text and removes secrets from optional fields', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.restoreSnapshot(state({
    subagents: [{ id: 'child', name: 'Child', status: 'completed', task: 't'.repeat(12001),
      progress: 'p'.repeat(181), resultPreview: 'r'.repeat(501), error: 'e'.repeat(4001) }],
    messages: [{ id: 'child-message', role: 'tool', text: 'x'.repeat(12001), at: 1, subagentId: 'child',
      tool: { name: 'shell', target: 'src/file.ts' } }],
  } as never));
  const restored = controller.snapshot();
  assert.equal(restored.subagents[0]?.task?.length, 12000);
  assert.equal(restored.subagents[0]?.taskOmitted, true);
  assert.equal(restored.subagents[0]?.progress?.length, 180);
  assert.equal(restored.subagents[0]?.resultPreview?.length, 500);
  assert.equal(restored.subagents[0]?.error?.length, 4000);
  assert.equal(restored.messages[0]?.text.endsWith('[Earlier output omitted]'), true);
  assert.equal(restored.subagents[0]?.historyOmitted, true);
});

test('snapshot restoration accepts image-only queued requests and ignores a non-array queue', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.restoreSnapshot(state({ queue: { not: 'an array' } as never }));
  assert.deepEqual(controller.snapshot().queue, []);
  controller.restoreSnapshot(state({ queue: [{ id: 'image-only', text: '', extras: {
    images: [{ mimeType: 'image/png', data: 'YQ==' }],
  } }] }));
  assert.equal(controller.snapshot().queue[0]?.id, 'image-only');
  controller.restoreSnapshot(state({ queue: [null] as never }));
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /未送信Queue/);
});

test('restored child history discards oversized metadata and bounds aggregate history', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const subagents = Array.from({ length: 8 }, (_, index) => ({ id: `child-${index}`, name: `Child ${index}`, status: 'completed' as const }));
  const messages = Array.from({ length: 104 }, (_, index) => ({
    id: `child-${index}`, role: 'tool' as const, text: 'x'.repeat(11900), at: index,
    subagentId: `child-${Math.floor(index / 13)}`,
  }));
  messages[0] = { ...messages[0]!, meta: { type: 'status', oversized: 'z'.repeat(30001) } } as never;
  controller.restoreSnapshot(state({ subagents, messages } as never));
  const restored = controller.snapshot();
  assert.ok(restored.messages.length < messages.length);
  assert.ok(restored.subagents.some((child) => child.historyOmitted));
  assert.equal(restored.messages.some((message) => JSON.stringify(message).length > 30000), false);
});

test('restoring circular child metadata keeps a readable transcript', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const meta = { type: 'status' } as Record<string, unknown>;
  meta.self = meta;
  controller.restoreSnapshot(state({ messages: [{ id: 'circular', role: 'status', text: 'progress', at: 1,
    subagentId: 'child', meta }], subagents: [{ id: 'child', name: 'Child', status: 'running' }] } as never));
  const restored = controller.snapshot();
  assert.equal(restored.messages[0]?.text, 'progress');
  assert.equal(restored.messages[0]?.meta, undefined);
});

test('restoring cyclic tool details still enforces child history limits', () => {
  const controller = new ChatController(baseSelection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const tool = { name: 'shell', kind: 'shell' } as Record<string, unknown>;
  tool.self = tool;
  controller.restoreSnapshot(state({ subagents: [{ id: 'child', name: 'Child', status: 'completed' }],
    messages: [{ id: 'cyclic-tool', role: 'tool', text: 'done', at: 1, subagentId: 'child', tool }],
  } as never));
  assert.equal(controller.snapshot().messages[0]?.text, 'done');
});

test('live child updates keep parent ownership and bound displayed tool output', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'parent', role: 'status', text: '', backendTurnId: 'backend-parent' });
      emit({ id: 'child-start', role: 'status', text: 'started', meta: { type: 'subagent', subagent: {
        id: 'child', name: 'Child', status: 'running', background: 'unknown', parentTurnId: 'backend-parent',
      } } });
      emit({ id: 'child-output', role: 'tool', text: 'o'.repeat(12001), subagentId: 'child', tool: {
        kind: 'shell', name: 'shell', target: 'src/file.ts', status: 'running',
      } });
      emit({ id: 'child-output-no-target', role: 'tool', text: 'still running', subagentId: 'child', tool: {
        kind: 'shell', name: 'shell', status: 'running',
      } });
      emit({ id: 'wait', role: 'status', text: '', meta: { type: 'subagentWait', subagentWait: {
        waiting: true,
      } } });
    },
    async dispose() {},
  }), () => {});
  await controller.send('inspect child');
  const snapshot = controller.snapshot();
  const parent = snapshot.turns[0];
  assert.equal(snapshot.subagents[0]?.parentTurnId, parent?.id);
  assert.equal(snapshot.subagents[0]?.progress, 'shell');
  assert.equal(snapshot.messages.find((message) => message.subagentId === 'child')?.text.endsWith('[Earlier output omitted]'), true);
  assert.equal(snapshot.subagentWaiting, undefined, 'turn completion clears the waiting marker');
  await controller.dispose();
});

test('uncertain execution errors preserve an unknown turn for recovery', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run() { throw Object.assign(new Error('connection lost'), { executionUncertain: true }); },
    async dispose() {},
  }), () => {});
  await controller.send('long running work');
  assert.equal(controller.snapshot().turns[0]?.status, 'unknown');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /connection lost/);
  await controller.dispose();
});

test('an uncertain planning run leaves the plan in an unknown phase', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run() { throw Object.assign(new Error('owner unavailable'), { executionUncertain: true }); },
    async dispose() {},
  }), () => {});
  controller.setModePreference('plan');
  await controller.send('create a plan');
  assert.equal(controller.snapshot().turns[0]?.intent, 'plan');
  assert.equal(controller.snapshot().plan.phase, 'unknown');
  await controller.dispose();
});

test('non-retryable execution errors explain that settings need repair', async () => {
  const controller = new ChatController(baseSelection, async () => ({
    async run() { throw Object.assign(new Error('invalid configuration'), { isRetryable: false }); },
    async dispose() {},
  }), () => {});
  await controller.send('start');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /設定の修正が必要/);
  await controller.dispose();
});
