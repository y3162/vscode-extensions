import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

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
