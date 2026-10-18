import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('interaction resolvers reject stale ids and tokens while preserving non-waiting error state', async () => {
  const controller = new ChatController(selection(), async () => ({ async run() {}, async dispose() {} }), () => {});
  const planPromise = controller.interactions.requestPlan({ id: 'plan-id', plan: 'Plan', todos: [] });
  const planToken = controller.interactionTokens().plan!;
  controller.resolvePlan('other-plan', 'accepted', planToken);
  controller.resolvePlan('plan-id', 'accepted', 'stale-token');
  assert.equal(controller.snapshot().pendingPlan?.id, 'plan-id');
  controller.setStatus('error');
  controller.resolvePlan('plan-id', 'rejected');
  assert.equal(await planPromise, 'rejected');
  assert.equal(controller.snapshot().status, 'error');
  controller.resolvePlan('plan-id', 'accepted');

  const answerPromise = controller.interactions.requestAnswers({ id: 'question-id', questions: [] });
  const questionToken = controller.interactionTokens().question!;
  controller.resolveAnswers('other-question', {}, questionToken);
  controller.resolveAnswers('question-id', {}, 'stale-token');
  assert.equal(controller.snapshot().pendingQuestion?.id, 'question-id');
  controller.setStatus('error');
  controller.resolveAnswers('question-id', { q: ['answer'] });
  assert.deepEqual(await answerPromise, { q: ['answer'] });
  assert.equal(controller.snapshot().status, 'error');
  controller.resolveAnswers('question-id', {});
  await controller.dispose();
});

test('plan and question resolution keeps a running agent out of idle while interactions are released', async () => {
  const planVisible = deferred();
  const questionVisible = deferred();
  const decisions: unknown[] = [];
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => ({
    async run() {
      const plan = controller.interactions.requestPlan({ id: 'active-plan', plan: 'Plan', todos: [] });
      planVisible.resolve();
      decisions.push(await plan);
      const answers = controller.interactions.requestAnswers({ id: 'active-question', questions: [] });
      questionVisible.resolve();
      decisions.push(await answers);
    },
    async dispose() {},
  }), () => {});
  try {
    const sending = controller.send('needs input');
    await planVisible.promise;
    assert.equal(controller.snapshot().status, 'waiting_approval');
    controller.resolvePlan('active-plan', 'accepted', controller.interactionTokens().plan!);
    assert.equal(controller.snapshot().status, 'running');
    await questionVisible.promise;
    assert.equal(controller.snapshot().status, 'waiting_approval');
    controller.resolveAnswers('active-question', { first: ['yes'] }, controller.interactionTokens().question!);
    assert.equal(controller.snapshot().status, 'running');
    await sending;
    assert.deepEqual(decisions, ['accepted', { first: ['yes'] }]);
    assert.equal(controller.snapshot().status, 'idle');
  } finally {
    await controller.dispose();
  }
});
