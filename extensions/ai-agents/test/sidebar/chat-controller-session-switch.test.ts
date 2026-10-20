import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, ImageAttachment, Selection } from '../../src/types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('reset waits for an overlapping model change and does not open another session', async () => {
  const gate = deferred();
  let opens = 0;
  let disposed = 0;
  let applied = '';
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      sessionId: 'thread-1',
      async run() {},
      async setModel(next) { applied = next.model; await gate.promise; },
      async dispose() { disposed += 1; },
    };
  }, () => {});
  await controller.send('hi');
  const updating = controller.updateSelection({ ...selection(), model: 'next' });
  let resetFinished = false;
  const resetting = controller.reset().then(() => { resetFinished = true; });
  await Promise.resolve();
  assert.equal(resetFinished, false);
  assert.equal(controller.snapshot().messages.length > 0, true);
  gate.resolve();
  await updating;
  await resetting;
  assert.equal(resetFinished, true);
  assert.equal(controller.snapshot().messages.length, 0);
  assert.equal(controller.snapshot().selection.model, 'next');
  assert.equal(applied, 'next');
  assert.equal(opens, 1);
  assert.equal(disposed, 1);

  const rejectGate = deferred();
  let rejectedOpens = 0;
  let rejectedDisposed = 0;
  const rejecting = new ChatController(selection(), async () => {
    rejectedOpens += 1;
    return {
      sessionId: 'thread-2',
      async run() {},
      async setModel() { await rejectGate.promise; throw new Error('rejected'); },
      async dispose() { rejectedDisposed += 1; },
    };
  }, () => {});
  await rejecting.send('hi');
  const rejectedUpdate = rejecting.updateSelection({ ...selection(), model: 'nope' });
  const rejectedReset = rejecting.reset();
  rejectGate.resolve();
  await assert.rejects(rejectedUpdate, /rejected/);
  await rejectedReset;
  assert.equal(rejecting.snapshot().selection.model, 'fixture');
  assert.equal(rejecting.snapshot().messages.length, 0);
  assert.equal(rejectedOpens, 1);
  assert.equal(rejectedDisposed, 1);

  const disposeGate = deferred();
  let duringOpens = 0;
  const during = new ChatController(selection(), async () => {
    duringOpens += 1;
    return { sessionId: 'thread-3', async run() {}, async dispose() { await disposeGate.promise; } };
  }, () => {});
  await during.send('hi');
  const resettingDuring = during.reset();
  const modelDuring = during.updateSelection({ ...selection(), model: 'later' });
  await Promise.resolve();
  assert.equal(during.snapshot().selection.model, 'fixture');
  disposeGate.resolve();
  await resettingDuring;
  await modelDuring;
  assert.equal(during.snapshot().selection.model, 'later');
  assert.equal(during.snapshot().messages.length, 0);
  assert.equal(duringOpens, 1);
});

test('updateSelection resets the session when provider or workspace changes', async () => {
  for (const next of [
    { ...selection(), provider: 'cursor' as const },
    { ...selection(), cwd: '/another-workspace' },
  ]) {
    const opened: Selection[] = [];
    let disposed = 0;
    const controller = new ChatController(selection(), async (selected) => {
      opened.push(selected);
      return { sessionId: `thread-${opened.length}`, async run() {}, async dispose() { disposed += 1; } };
    }, () => {});
    await controller.send('first session');
    assert.equal(controller.snapshot().messages.some((message) => message.text === 'first session'), true);

    await controller.updateSelection(next);
    assert.deepEqual(controller.snapshot().selection, next);
    assert.deepEqual(controller.snapshot().messages, []);
    assert.equal(disposed, 1);
    assert.deepEqual(opened, [selection()]);

    await controller.send('second session');
    assert.deepEqual(opened, [selection(), next]);
    assert.equal(controller.snapshot().turns.length, 1);
    assert.equal(controller.snapshot().turns[0]?.status, 'completed');
    assert.equal(disposed, 1);
    await controller.dispose();
    assert.equal(disposed, 2);
  }
});

test('restore, review, and mode changes keep one session and surface retry boundaries', async () => {
  let opens = 0;
  let reviewed = 0;
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      sessionId: 'thread-1',
      async run() {},
      async review(target, emit, signal) {
        reviewed += 1;
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (target === 'base') throw Object.assign(new Error('bad config'), { isRetryable: false });
        emit({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, scope: 'request', source: 'review' } } });
        emit({ id: 'answer', role: 'assistant', text: 'reviewed' });
      },
      async dispose() {},
    };
  }, () => {});
  const saved = controller.snapshot();
  saved.turns = [{ id: 't', startedAt: 1, status: 'running', waitMs: 0, mode: 'agent', model: 'm', intent: 'chat' }];
  saved.subagents = [{ id: 'c', name: 'C', status: 'running', background: true }];
  saved.terminals = [{ processId: 'p', status: 'running' }];
  saved.plan = { phase: 'planning', revisions: [] };
  saved.queue = [{ id: 'q', text: 'queued' }];
  saved.autoApprove = true;
  saved.busy = true;
  controller.restoreSnapshot(saved, 'kept');
  const restored = controller.snapshot();
  assert.equal(restored.busy, false);
  assert.deepEqual(restored.queue, [{ id: 'q', text: 'queued' }]);
  assert.equal(restored.autoApprove, false);
  assert.equal(restored.turns[0]?.status, 'unknown');
  assert.equal(restored.turns[0]?.endedAt, undefined);
  assert.equal(restored.subagents[0]?.status, 'unknown');
  assert.equal(restored.terminals[0]?.status, 'unknown');
  assert.equal(restored.plan.phase, 'unknown');
  assert.equal(controller.sessionId(), 'kept');
  saved.plan = { phase: 'building', revisions: [], current: { id: 'p', revision: 1, markdown: 'm', todos: [], source: 'assistant-text', createdAt: 1 } };
  controller.restoreSnapshot(saved, 'kept');
  assert.equal(controller.snapshot().plan.phase, 'unknown');
  assert.equal(controller.hasSession(), false);
  assert.equal(controller.currentSession(), undefined);
  controller.setAutoApprove(true);
  controller.setStatus('idle');
  controller.setStatus('error');
  controller.notify('note');
  controller.replaceSessions([{ id: 's', title: 'Saved', updatedAt: 't', provider: 'codex' }]);
  assert.equal(controller.snapshot().autoApprove, true);
  assert.equal(controller.snapshot().status, 'error');
  assert.equal(controller.snapshot().messages.some((message) => message.text === 'note'), true);
  assert.equal(controller.snapshot().sessions[0]?.title, 'Saved');
  assert.equal(await controller.applyMode('plan'), true);
  await controller.openSession();
  await controller.review('uncommitted');
  assert.equal(reviewed, 1);
  assert.equal(controller.snapshot().messages.some((message) => message.text === 'reviewed'), true);
  assert.equal(controller.snapshot().messages.some((message) => message.text === '' && message.meta?.type === 'usage'), false);
  await controller.review('base');
  assert.match(controller.snapshot().messages.find((message) => message.role === 'error')?.text ?? '', /設定の修正/);
  assert.equal(opens, 1);
  const plain = new ChatController(selection(), async () => {
    opens += 1;
    return { async run() {}, async dispose() {} };
  }, () => {});
  await plain.send('hi');
  assert.equal(await plain.applyMode('ask'), false);
  assert.equal(plain.snapshot().turns.at(-1)?.mode, 'agent');
  await assert.rejects(plain.review('uncommitted'), /コードレビューAPI/);
  let modeApplied = '';
  const switching = new ChatController(selection(), async () => ({
    async run() {},
    async setMode(mode) { modeApplied = mode; },
    async dispose() {},
  }), () => {});
  await switching.send('hello');
  assert.equal(await switching.select(selection()), undefined);
  assert.equal(switching.snapshot().messages.length > 0, true);
  await switching.select({ ...selection(), model: 'other' });
  assert.equal(switching.snapshot().selection.model, 'other');
  assert.equal(switching.snapshot().messages.length, 0);
  await switching.send('again');
  assert.equal(await switching.applyMode('ask'), true);
  assert.equal(modeApplied, 'ask');
  const plan = {
    phase: 'implemented' as const, revisions: [],
    current: { id: 'p', revision: 1, markdown: 'keep', todos: [{ content: 'step', status: 'pending' }], source: 'assistant-text' as const, createdAt: 1 },
  };
  switching.restorePlan(plan);
  assert.equal(switching.snapshot().plan.phase, 'implemented');
  assert.equal(switching.snapshot().todos[0]?.content, 'step');
  switching.restorePlan(plan);
  assert.equal(switching.snapshot().plan.current?.restored, true);
  let child = new ChatController(selection(), async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'sub', role: 'status', text: 'running', meta: { type: 'subagent', subagent: { id: 'same', name: 'Same', status: 'running', background: true } } });
      emit({ id: 'sub', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { id: 'same', name: 'Same', status: 'completed', background: false, resultPreview: 'ok' } } });
    },
    async dispose() {},
  }), () => {});
  await child.send('child');
  assert.equal(child.snapshot().subagents.length, 1);
  assert.equal(child.snapshot().subagents[0]?.status, 'completed');
  assert.equal(child.snapshot().subagents[0]?.resultPreview, 'ok');
  const visible = deferred();
  const decision = deferred<string>();
  let paused!: ChatController;
  paused = new ChatController(selection(), async () => ({
    async run() {
      decision.resolve(await paused.interactions.requestPermission({ id: 'p', title: 'Run', detail: 'cmd', kind: 'shell' }));
    },
    async dispose() {},
  }), (state) => { if (state.pendingPermission) visible.resolve(); });
  const sent = paused.send('wait');
  await visible.promise;
  assert.equal(paused.interactionTokens().plan, null);
  assert.equal(paused.interactionTokens().question, null);
  paused.resolvePermission('p', 'allow-once', paused.interactionTokens().permission!);
  await sent;
  assert.equal(await decision.promise, 'allow-once');
  assert.equal(typeof paused.snapshot().turns[0]?.waitMs, 'number');
});

test('a missing terminal in a successful post-reload list remains unknown', async () => {
  let background!: (update: AgentUpdate) => void;
  const controller = new ChatController(selection(), async () => ({
    sessionId: 'thread-1',
    async run() {},
    async listBackgroundTerminals() {
      background({ id: 'terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: [] } });
      return [];
    },
    subscribeBackgroundUpdates(listener) { background = listener; return () => {}; },
    async dispose() {},
  }), () => {});
  const saved = controller.snapshot();
  saved.terminals = [{ processId: 'process-before-reload', command: 'long-running-job', status: 'running' }];
  controller.restoreSnapshot(saved, 'thread-1');
  assert.equal(controller.snapshot().terminals[0]?.status, 'unknown');

  await controller.openSession();

  assert.deepEqual(controller.snapshot().terminals, [{
    processId: 'process-before-reload', command: 'long-running-job', status: 'unknown',
  }]);
  await controller.dispose();
});
