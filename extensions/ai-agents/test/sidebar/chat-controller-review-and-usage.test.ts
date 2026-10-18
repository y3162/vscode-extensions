import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

test('review deduplicates repeated updates, absorbs empty usage, and reports failure without leaving busy state', async () => {
  const usage: UsageStats = {
    scope: 'session', inputTokens: 12, outputTokens: 5, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 17,
  };
  let calls = 0;
  const session: AgentSession = {
    sessionId: 'review-state-thread',
    async run() {},
    async review(_target, emit) {
      calls += 1;
      emit({ id: 'review-answer', role: 'assistant', text: 'first draft' });
      const firstAt = Date.now() - 1000;
      emit({ id: 'review-answer', role: 'assistant', text: 'final review', at: firstAt, final: true });
      emit({ id: 'review-usage', role: 'status', text: '', meta: { type: 'usage', usage } });
      const error = Object.assign(new Error('review command rejected'), { isRetryable: false, operation: 'review' });
      throw error;
    },
    async dispose() {},
  };
  const controller = new ChatController(selection, async () => session, () => {});

  await controller.openSession();
  await controller.review('base');
  const state = controller.snapshot();
  const answer = state.messages.filter((message) => message.id.endsWith(':review-answer'));
  const visibleUsage = state.messages.filter((message) => message.id.endsWith(':review-usage'));
  const failure = state.messages.find((message) => message.role === 'error');
  assert.equal(calls, 1);
  assert.equal(answer.length, 1);
  assert.equal(answer[0]?.text, 'final review');
  assert.equal(answer[0]?.final, true);
  assert.equal(visibleUsage.length, 0, 'empty usage records update counters without creating a transcript row');
  assert.equal(state.usage?.totalTokens, 17);
  assert.match(failure?.text ?? '', /review command rejected/);
  assert.match(failure?.text ?? '', /設定の修正が必要です/);
  assert.equal(state.busy, false);
  assert.equal(state.status, 'idle');
  await controller.dispose();
});

test('request-scoped usage is ignored after a session total and allow-session permission is reused exactly', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'session-total', role: 'status', text: '', meta: { type: 'usage', usage: { scope: 'session', source: 'fixture', inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 22 } } });
      emit({ id: 'request-total', role: 'status', text: '', meta: { type: 'usage', usage: { scope: 'request', source: 'fixture', inputTokens: 900, outputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 1800 } } });
    },
    async dispose() {},
  }), () => {});

  const permission = controller.interactions.requestPermission({ id: 'allow-rule', title: 'Run trusted task', detail: 'fixed command', kind: 'shell' });
  assert.equal(controller.snapshot().pendingPermission?.id, 'allow-rule');
  controller.resolvePermission('allow-rule', 'allow-session', controller.interactionTokens().permission ?? undefined);
  assert.equal(await permission, 'allow-session');
  assert.equal(await controller.interactions.requestPermission({ id: 'reused-rule', title: 'Run trusted task', detail: 'fixed command', kind: 'shell' }), 'allow-once');

  await controller.send('record usage');
  const state = controller.snapshot();
  assert.equal(state.usage?.scope, 'session');
  assert.equal(state.usage?.totalTokens, 22);
  assert.equal(state.turns[0]?.usage?.totalTokens, 22);
  assert.equal(state.messages.some((message) => message.id.endsWith(':request-total')), false);
  await controller.dispose();
});
