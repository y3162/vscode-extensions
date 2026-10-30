import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

test('failed turn validation preserves the selection and never starts the backend', async () => {
  const chosen: Selection = { provider: 'cursor', cwd: '/workspace', model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'bad' }] };
  let launches = 0;
  const controller = new ChatController(chosen, async () => { launches++; return { async run() {}, async dispose() {} }; }, () => {}, undefined,
    async () => { throw new Error('catalog unavailable'); });
  await controller.send('hello');
  assert.equal(launches, 0);
  assert.deepEqual(controller.snapshot().selection, chosen);
  assert.match(controller.snapshot().messages.find(message => message.role === 'error')?.text ?? '', /catalog unavailable/);
  await controller.dispose();
});

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
