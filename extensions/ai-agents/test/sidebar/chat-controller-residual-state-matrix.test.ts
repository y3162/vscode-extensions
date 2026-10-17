import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

function restoredPlan(phase: ChatState['plan']['phase']): ChatState['plan'] {
  return {
    phase,
    revisions: [],
    draft: { id: 'draft', revision: 0, markdown: 'discard this draft', todos: [], source: 'assistant-text', createdAt: 1 },
    current: { id: 'saved-plan', revision: 3, markdown: 'saved plan', todos: [{ content: 'keep state', status: 'pending' }], source: 'assistant-text', createdAt: 2 },
  };
}

test('selection can change without an open session and no-op selection preserves the chosen model', async () => {
  let factoryCalls = 0;
  const controller = new ChatController(selection, async () => {
    factoryCalls += 1;
    return { async run() {}, async dispose() {} };
  }, () => {});

  const chosen = { ...selection, model: 'selected-before-open', modelParams: [{ id: 'effort', value: 'high' }] };
  await controller.updateSelection(chosen);
  await controller.updateSelection({ ...chosen, modelParams: [{ id: 'effort', value: 'high' }] });
  await controller.select({ ...chosen });

  assert.deepEqual(controller.snapshot().selection, chosen);
  assert.equal(controller.hasSession(), false);
  assert.equal(factoryCalls, 0);
  await controller.dispose();
});

test('restored plans normalize transient phases and cannot overwrite an already restored plan', () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  controller.restorePlan({ phase: 'idle', revisions: [] });
  assert.equal(controller.snapshot().plan.current, undefined);

  const source = restoredPlan('planning');
  controller.restorePlan(source);
  const restored = controller.snapshot();
  assert.equal(restored.plan.phase, 'ready');
  assert.equal(restored.plan.draft, undefined);
  assert.equal(restored.plan.current?.restored, true);
  assert.deepEqual(restored.todos, source.current?.todos);

  controller.restorePlan(restoredPlan('implemented'));
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().plan.current?.id, 'saved-plan');
});

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

test('a session without setMode refuses runtime mode changes but still remembers the initial preference', async () => {
  const modes: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, _emit, _extras, turn) { modes.push(turn?.mode ?? ''); },
    async dispose() {},
  }), () => {});

  assert.equal(await controller.applyMode('plan'), true, 'without a session the preference can be changed');
  await controller.send('use the remembered mode');
  assert.deepEqual(modes, ['plan']);
  assert.equal(await controller.applyMode('ask'), false, 'an open session without setMode cannot change execution mode');
  await controller.send('keep the remembered mode');
  assert.deepEqual(modes, ['plan', 'plan']);
  await controller.dispose();
});

test('sendQueued reorders an existing item, cancels the active turn, then drains it once', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const prompts: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(prompt, signal) {
      prompts.push(prompt);
      if (prompt !== 'hold') return;
      enter();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('cancelled by selected queue item'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
    async dispose() {},
  }), () => {});

  const holding = controller.send('hold');
  await entered;
  controller.enqueue('first queued');
  controller.enqueue('selected queued');
  const queued = controller.snapshot().queue;
  const selectedId = queued[1]!.id;
  const sendSelected = controller.sendQueued(selectedId);
  await Promise.all([holding, sendSelected]);

  assert.deepEqual(prompts, ['hold', 'selected queued', 'first queued']);
  assert.equal(controller.snapshot().turns[0]?.status, 'cancelled');
  assert.equal(controller.snapshot().queue.length, 0);
  assert.equal(controller.snapshot().turns.filter((turn) => turn.status === 'completed').length, 2);
  await controller.dispose();
});

test('steerQueued keeps refused input queued and removes it only after backend acceptance', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let allowSteer = false;
  const steered: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal) {
      enter();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        void resolve;
      });
    },
    async steer(text) { steered.push(text); return allowSteer; },
    async dispose() {},
  }), () => {});

  const active = controller.send('active turn');
  await entered;
  controller.enqueue('visible queued prompt', { displayText: 'displayed follow-up' });
  const queuedId = controller.snapshot().queue[0]!.id;
  await assert.doesNotReject(controller.steerQueued('missing'));
  assert.equal(controller.snapshot().queue.length, 1);
  await assert.rejects(controller.steerQueued(queuedId), /追加入力に対応していません/);
  assert.equal(controller.snapshot().queue.length, 1);
  allowSteer = true;
  await controller.steerQueued(queuedId);
  assert.deepEqual(steered, ['displayed follow-up', 'displayed follow-up']);
  assert.equal(controller.snapshot().queue.length, 0);
  controller.stop();
  await active;
  await controller.dispose();
});

test('hibernate waits while terminal or child work is live and is harmless without a session', async () => {
  let disposed = 0;
  let emit!: (update: AgentUpdate) => void;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'guarded-hibernate',
    async run(_prompt, _signal, onUpdate) {
      emit = onUpdate;
      emit({ id: 'child', role: 'status', text: 'running', meta: { type: 'subagent', subagent: { id: 'child', name: 'child', status: 'running', background: true } } });
    },
    async dispose() { disposed += 1; },
  }), () => {});

  await controller.hibernate();
  assert.equal(disposed, 0, 'no session is a no-op');
  await controller.send('create live child');
  await controller.hibernate();
  assert.equal(controller.hasSession(), true);
  assert.equal(disposed, 0);
  emit({ id: 'child', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { id: 'child', name: 'child', status: 'completed', background: false } } });
  controller.setTerminals([{ processId: 'terminal-1', status: 'running' }]);
  await controller.hibernate();
  assert.equal(controller.hasSession(), true, 'a live background terminal keeps its owning session open');
  controller.setTerminals([{ processId: 'terminal-1', status: 'completed' }]);
  await controller.hibernate();
  assert.equal(controller.hasSession(), false);
  assert.equal(disposed, 1);
});

test('a workspace switch waits for a pending model update before disposing the old session', async () => {
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  let disposed = 0;
  let factories = 0;
  const controller = new ChatController(selection, async () => {
    factories += 1;
    return {
      sessionId: `selection-thread-${factories}`,
      async run() {},
      async setModel() { await modelGate; },
      async dispose() { disposed += 1; },
    };
  }, () => {});

  await controller.send('establish the first session');
  const update = controller.updateSelection({ ...selection, model: 'next model' });
  await Promise.resolve();
  const selectionChange = controller.select({ ...selection, provider: 'cursor' });
  await Promise.resolve();
  assert.deepEqual(controller.snapshot().selection, selection, 'the pending model selection is not published before backend acceptance');
  assert.equal(disposed, 0, 'the old backend is not disposed while its model update is pending');
  releaseModel();
  await Promise.all([update, selectionChange]);
  assert.deepEqual(controller.snapshot().selection, { ...selection, provider: 'cursor' });
  assert.equal(disposed, 1);
  assert.equal(factories, 1);
  await controller.dispose();
});

test('a duplicate Build while the plan is already building does not start another turn', async () => {
  let enterBuild!: () => void;
  const buildEntered = new Promise<void>((resolve) => { enterBuild = resolve; });
  let releaseBuild!: () => void;
  const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const prompts: string[] = [];
  const controller = new ChatController(selection, async () => ({
    sessionId: 'single-build',
    async run(prompt, _signal, emit, _extras, turn) {
      prompts.push(prompt);
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Build safely', source: 'assistant-text' } } });
      if (turn?.intent === 'build') {
        enterBuild();
        await buildGate;
      }
    },
    async dispose() {},
  }), () => {});

  controller.setModePreference('plan');
  await controller.send('prepare a plan');
  const plan = controller.snapshot().plan.current!;
  const firstBuild = controller.build(plan.id, plan.revision, selection);
  await buildEntered;
  assert.equal(controller.snapshot().plan.phase, 'building');
  await controller.build(plan.id, plan.revision, selection);
  assert.equal(prompts.length, 2);
  releaseBuild();
  await firstBuild;
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  await controller.dispose();
});

test('rewind refuses a completed local turn with no backend turn identity before forking', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-missing-backend-id-'));
  let forks = 0;
  const controller = new ChatController({ ...selection, cwd }, async () => ({
    sessionId: 'missing-backend-turn',
    async run() {},
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn() { forks += 1; return 'must-not-fork'; },
    async dispose() {},
  }), () => {}, {
    journalDirectory: path.join(cwd, 'journals'), conversationId: () => 'conversation', enabled: () => true, async flush() {},
  });

  try {
    await controller.send('local turn without backend id');
    await assert.rejects(controller.previewRewind(controller.snapshot().turns[0]!.id), /Backend turn ID/);
    assert.equal(forks, 0);
    assert.equal(controller.snapshot().turns[0]?.status, 'completed');
    assert.equal(controller.snapshot().busy, false);
  } finally {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
