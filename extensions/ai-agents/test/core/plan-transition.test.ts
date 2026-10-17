import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { commitDraft, maxPlanRevisions, planningFailed, requestBuild, stageDraft } from '../../src/plan-state.js';
import { emptyPlanState, type AgentSession, type Selection } from '../../src/types.js';

const selection: Selection = { provider: 'cursor', cwd: '/workspace', model: 'composer-2.5' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function planSession(behavior: 'fail' | 'empty' | 'hold' | 'explode' | 'ok'): AgentSession {
  return {
    sessionId: 'thread-a',
    async run(_prompt, signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        if (behavior === 'fail') throw new Error('planner down');
        if (behavior === 'empty') {
          emit({ id: 'plan', role: 'status', text: ' ', meta: { type: 'plan', plan: { markdown: '   ', source: 'assistant-text' } } });
          return;
        }
        emit({ id: 'plan', role: 'status', text: 'Do the thing', meta: { type: 'plan', plan: { markdown: 'Do the thing', source: 'assistant-text' } } });
        return;
      }
      if (behavior === 'hold') {
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return;
      }
      if (behavior === 'explode') throw new Error('build exploded');
      emit({ id: 'built', role: 'assistant', text: 'built' });
    },
    async dispose() {},
  };
}

test('a failed first plan leaves no current plan', async () => {
  const controller = new ChatController(selection, async () => planSession('fail'), () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  assert.equal(controller.snapshot().plan.phase, 'idle');
  assert.equal(controller.snapshot().plan.current, undefined);
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /planner down/);
});

test('empty plan markdown is not treated as a finished plan', async () => {
  const controller = new ChatController(selection, async () => planSession('empty'), () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  assert.equal(controller.snapshot().plan.phase, 'idle');
  assert.equal(controller.snapshot().plan.current, undefined);
  assert.equal(controller.snapshot().plan.error, '計画は作成されませんでした。');
});

test('Stop after a build has started does not mark the plan implemented', async () => {
  const entered = deferred();
  const controller = new ChatController(selection, async () => ({
    ...planSession('hold'),
    async run(prompt, signal, emit, extras, turn) {
      if (turn?.intent === 'build') entered.resolve();
      return planSession('hold').run(prompt, signal, emit, extras, turn);
    },
  }), () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  const current = controller.snapshot().plan.current!;
  const building = controller.build(current.id, current.revision, selection);
  await entered.promise;
  controller.stop();
  await building;
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().plan.current?.markdown, 'Do the thing');
});

test('a build that throws leaves the plan ready', async () => {
  const controller = new ChatController(selection, async () => planSession('explode'), () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  const current = controller.snapshot().plan.current!;
  await controller.build(current.id, current.revision, selection);
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /build exploded/);
});

test('a build from another session is refused', async () => {
  const session = planSession('ok');
  const controller = new ChatController(selection, async () => session, () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  const current = controller.snapshot().plan.current!;
  session.sessionId = 'thread-b';
  await assert.rejects(controller.build(current.id, current.revision, selection), /別のセッション/);
  assert.equal(controller.snapshot().plan.phase, 'ready');
});

test('an implemented plan cannot be built again', async () => {
  const controller = new ChatController(selection, async () => planSession('ok'), () => {});
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  const current = controller.snapshot().plan.current!;
  await controller.build(current.id, current.revision, selection);
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  await assert.rejects(controller.build(current.id, current.revision, selection), /準備ができていません/);
});

test('a second revise is rejected while the first revise is running', async () => {
  const entered = deferred();
  const controller = new ChatController(selection, async () => ({
    async run(prompt, signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'plan', role: 'status', text: 'First', meta: { type: 'plan', plan: { markdown: 'First', source: 'assistant-text' } } });
        return;
      }
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  await controller.send('plan', undefined, { intent: 'plan', mode: 'plan', selection });
  const revising = controller.send('change', undefined, { intent: 'revise', mode: 'plan', selection });
  await entered.promise;
  await assert.rejects(controller.send('again', undefined, { intent: 'revise', mode: 'plan', selection }), /実行中/);
  controller.stop();
  await revising;
  assert.equal(controller.snapshot().plan.current?.markdown, 'First');
});

test('a stale plan revision and a failed revision of an existing plan keep the previous markdown', () => {
  const ready = commitDraft(stageDraft(emptyPlanState(), { markdown: 'First', source: 'assistant-text' }), selection, 'thread-a');
  const stale = requestBuild(ready, ready.current!.id, ready.current!.revision + 1, selection, 'thread-a');
  assert.equal('error' in stale && stale.error, '表示中の計画と一致しません。');
  const failed = { ...ready, phase: 'revising' as const, revisionBasePhase: 'ready' as const, draft: { ...ready.current!, markdown: 'Partial' } };
  const restored = planningFailed(failed, 'revision failed');
  assert.equal(restored.phase, 'ready');
  assert.equal(restored.current?.markdown, 'First');
  assert.equal(restored.draft, undefined);
  assert.equal(restored.error, 'revision failed');
});
test('only the newest plan revisions are retained and a building plan rejects another build', () => {
  let state = emptyPlanState();
  for (let index = 1; index <= maxPlanRevisions + 1; index += 1) {
    state = stageDraft(state, { markdown: `plan ${index}`, source: 'assistant-text' });
    state = commitDraft(state, selection, 'thread-a');
  }
  assert.equal(state.revisions.length, maxPlanRevisions);
  assert.equal(state.revisions[0]?.markdown, 'plan 2');
  assert.equal(state.current?.markdown, `plan ${maxPlanRevisions + 1}`);
  const building = { ...state, phase: 'building' as const };
  const refused = requestBuild(building, state.current!.id, state.current!.revision, selection, 'thread-a');
  assert.equal('error' in refused && refused.error, '実装はすでに始まっています。');
});
