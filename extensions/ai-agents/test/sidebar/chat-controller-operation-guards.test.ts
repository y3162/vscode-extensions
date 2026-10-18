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

test('review is blocked while changing the model', async () => {
  const entered = deferred();
  const release = deferred();
  let reviewed = 0;
  const controller = new ChatController(selection(), async () => ({
    async run() {},
    async setModel() { entered.resolve(); await release.promise; },
    async review() { reviewed += 1; },
    async dispose() {},
  }), () => {});
  try {
    await controller.send('open session');
    const changing = controller.updateSelection({ ...selection(), model: 'next' });
    await entered.promise;
    await assert.rejects(controller.review('base'), /実行中です/);
    assert.equal(reviewed, 0);
    release.resolve();
    await changing;
    assert.equal(controller.snapshot().selection.model, 'next');
  } finally {
    release.resolve();
    await controller.dispose();
  }
});

test('Build rejects a provider or workspace change before mutating the plan or opening another session', async () => {
  const runs: string[] = [];
  let opens = 0;
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return {
      async run(prompt, _signal, emit, _extras, turn) {
        runs.push(prompt);
        if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: '', meta: { type: 'plan', plan: { markdown: 'Keep this plan', source: 'assistant-text' } } });
      },
      async dispose() {},
    };
  }, () => {});
  controller.setModePreference('plan');
  try {
    await controller.send('prepare');
    const plan = controller.snapshot().plan.current!;
    await assert.rejects(controller.build(plan.id, plan.revision, { ...selection(), cwd: '/other-workspace' }), /同じ会話/);
    await assert.rejects(controller.build(plan.id, plan.revision, { ...selection(), provider: 'cursor' }), /同じ会話/);
    assert.equal(controller.snapshot().plan.phase, 'ready');
    assert.deepEqual(runs, ['prepare']);
    assert.equal(opens, 1);
  } finally {
    await controller.dispose();
  }
});
