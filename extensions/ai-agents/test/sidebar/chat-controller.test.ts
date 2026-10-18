import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import type { AgentSession, Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('image-only requests run directly, through the queue, and on an explicit retry', async () => {
  const extras = { images: [{ mimeType: 'image/png' as const, data: 'aW1hZ2U=', name: 'image.png' }], attachments: ['image.png'] };
  const requests: Array<{ prompt: string; images: unknown }> = [];
  const queuedDone = deferred();
  const controller = new ChatController(selection, async () => ({
    async run(prompt, _signal, _emit, sent) { requests.push({ prompt, images: sent?.images }); },
    async dispose() {},
  }), (state) => { if (state.turns.length === 3 && !state.busy) queuedDone.resolve(); });
  await controller.send('', extras);
  const userId = controller.snapshot().messages[0]!.id;
  assert.deepEqual(controller.retryInput(userId), { prompt: '', extras });
  await controller.send('', { ...extras, retryOf: userId });
  assert.equal(controller.snapshot().messages.filter((message) => message.role === 'user').length, 1);
  controller.enqueue('', extras);
  await queuedDone.promise;
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ prompt: '', images: extras.images })));
  assert.equal(controller.snapshot().messages.filter((message) => message.role === 'user').length, 2);
  await controller.dispose();
});

test('restoring a conversation keeps queued image requests visible and waits for an explicit send', async () => {
  const image = { mimeType: 'image/png', data: 'aW1hZ2U=', name: 'queued.png' };
  const saved = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {}).snapshot();
  saved.busy = true;
  saved.status = 'running';
  saved.queue = [{ id: 'queued-image', text: 'inspect this image', extras: { images: [image] } }];

  let runCount = 0;
  let resumeId: string | undefined;
  const restored = new ChatController(selection, async (_selection, context) => {
    resumeId = context?.resumeId;
    return { sessionId: 'backend-session', async run() { runCount += 1; }, async dispose() {} };
  }, () => {});
  restored.restoreSnapshot(saved, 'backend-session');
  assert.equal(restored.snapshot().busy, false);
  assert.equal(restored.snapshot().status, 'idle');
  assert.deepEqual(restored.snapshot().queue, saved.queue);

  await restored.openSession();
  assert.equal(resumeId, 'backend-session');
  assert.equal(runCount, 0, 'restoring the Backend session must not replay an unsent prompt');
  assert.deepEqual(restored.snapshot().queue, saved.queue);
  await restored.dispose();
});

test('restoring a queue with unavailable image bytes drops it with reattachment guidance', async () => {
  const saved = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {}).snapshot();
  saved.queue = [{ id: 'lost-image', text: 'inspect this image', extras: { images: [{ mimeType: 'image/svg+xml', data: '<svg/>' }] } }];
  const restored = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  restored.restoreSnapshot(saved, 'backend-session');
  assert.deepEqual(restored.snapshot().queue, []);
  assert.ok(restored.snapshot().messages.some((message) => /reattach the image/i.test(message.text)));
  await restored.dispose();
});

test('continues the same session and replaces item snapshots without mixing turn IDs', async () => {
  let created = 0;
  const session: AgentSession = {
    async run(prompt, _signal, emit) {
      emit({ id: 'item_0', role: 'assistant', text: 'partial' });
      emit({ id: 'item_0', role: 'assistant', text: `reply: ${prompt}` });
    }, async dispose() {},
  };
  const controller = new ChatController(selection, async () => { created++; return session; }, () => {});
  await controller.send('first');
  await controller.send('second');
  assert.equal(created, 1);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['first', 'reply: first', 'second', 'reply: second']);
  assert.equal(new Set(controller.snapshot().messages.map((message) => message.id)).size, 4);
});

test('a running child does not imply parent wait; backend wait events set and clear that state', async () => {
  const entered = deferred();
  const release = deferred();
  let emitUpdate!: (update: import('../../src/types.js').AgentUpdate) => void;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emitUpdate = emit;
      emit({ id: 'child', role: 'status', text: 'child work', meta: { type: 'subagent', subagent: { id: 'child-1', name: 'Explorer', status: 'running', background: true } } });
      entered.resolve();
      await release.promise;
      emit({ id: 'answer', role: 'assistant', text: 'done' });
    }, async dispose() {},
  }), () => {});
  const running = controller.send('inspect in parallel');
  await entered.promise;
  assert.equal(controller.snapshot().subagents[0]?.status, 'running');
  assert.equal(controller.snapshot().subagentWaiting, undefined, 'child presence alone does not mark the parent waiting');
  const startedAt = Date.now() - 50;
  emitUpdate({ id: 'wait-call', role: 'status', text: '', meta: { type: 'subagentWait', subagentWait: { waiting: true, startedAt } } });
  assert.equal(controller.snapshot().subagentWaiting?.startedAt, startedAt);
  emitUpdate({ id: 'wait-call', role: 'status', text: '', meta: { type: 'subagentWait', subagentWait: { waiting: false } } });
  assert.equal(controller.snapshot().subagentWaiting, undefined, 'the parent wait clears on the backend completion event');
  emitUpdate({ id: 'wait-call', role: 'status', text: '', meta: { type: 'subagentWait', subagentWait: { waiting: true, startedAt } } });
  controller.stop();
  assert.equal(controller.snapshot().subagentWaiting, undefined, 'parent Stop cannot leave a stale waiting state');
  release.resolve();
  await running;
  await controller.dispose();
});

test('child event history redacts secrets and stays within per-child storage limits', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'spawn', role: 'status', text: 'child', meta: { type: 'subagent', subagent: { id: 'child-1', name: 'Explorer', status: 'running', background: true } } });
      emit({ id: 'secret', role: 'tool', text: 'api_key=super-secret-value', subagentId: 'child-1' });
      for (let index = 0; index < 85; index += 1) emit({ id: `event-${index}`, role: 'tool', text: `event ${index}`, subagentId: 'child-1' });
    }, async dispose() {},
  }), () => {});
  await controller.send('inspect');
  const state = controller.snapshot();
  const rows = state.messages.filter((message) => message.subagentId === 'child-1');
  assert.equal(rows.length, 80);
  assert.equal(rows.some((message) => message.text.includes('super-secret-value')), false);
  assert.equal(state.subagents[0]?.historyOmitted, true);
  await controller.dispose();
});

test('restored child details redact and bound saved text, metadata, and history', async () => {
  const factory = async (): Promise<AgentSession> => ({ async run() {}, async dispose() {} });
  const source = new ChatController(selection, factory, () => {});
  const saved = source.snapshot();
  saved.subagents.push({ id: 'child-restore', name: 'Explorer', status: 'running', background: 'unknown', task: 'api_key=task-secret', progress: 'token=progress-secret' });
  saved.messages.push({
    id: 'child-log', role: 'tool', text: `sk-${'x'.repeat(80)} ${'y'.repeat(13000)}`, subagentId: 'child-restore',
    tool: { kind: 'shell', name: 'command', status: 'completed', target: 'token=command-secret' },
    meta: { type: 'plan', plan: { markdown: 'password=plan-secret', source: 'assistant-text' } },
  });
  const restored = new ChatController(selection, factory, () => {});
  restored.restoreSnapshot(saved);
  const child = restored.snapshot().subagents[0]!;
  const log = restored.snapshot().messages.find((item) => item.subagentId === child.id)!;
  assert.equal(child.status, 'unknown');
  assert.equal(child.task, 'api_key=[redacted]');
  assert.equal(child.progress, 'token=[redacted]');
  assert.equal(log.text.includes('xxxxxxxx'), false);
  assert.equal(log.tool?.target, 'token=[redacted]');
  assert.equal(JSON.stringify(log.meta).includes('plan-secret'), false);
  assert.equal(child.historyOmitted, true);
  await source.dispose();
  await restored.dispose();
});

test('rejects simultaneous sends, aborts the active run, and allows a follow-up', async () => {
  const entered = deferred();
  let count = 0;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emit) {
      if (++count === 1) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } else emit({ id: 'answer', role: 'assistant', text: 'recovered' });
    }, async dispose() {},
  }), () => {});
  const running = controller.send('long request');
  await entered.promise;
  await assert.rejects(controller.send('overlap'), /実行中/);
  controller.stop();
  await running;
  assert.equal(controller.snapshot().busy, false);
  assert.ok(controller.snapshot().messages.some((message) => message.text === '停止しました。'));
  await controller.send('follow-up');
  assert.equal(controller.snapshot().messages.at(-1)?.text, 'recovered');
});

test('Stop during asynchronous session initialization prevents any prompt from running', async () => {
  const initialized = deferred();
  let runs = 0;
  let disposed = 0;
  const controller = new ChatController(selection, async () => {
    await initialized.promise;
    return { async run() { runs++; }, async dispose() { disposed++; } };
  }, () => {});
  const running = controller.send('do not run');
  controller.stop();
  initialized.resolve();
  await running;
  await controller.reset();
  assert.equal(runs, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('switching providers disposes the old session and clears its transcript', async () => {
  let disposed = 0;
  const seen: string[] = [];
  const controller = new ChatController(selection, async (options) => {
    seen.push(options.provider);
    return { async run() {}, async dispose() { disposed++; } };
  }, () => {});
  await controller.send('Codex');
  await controller.select({ ...selection, provider: 'cursor' });
  assert.equal(disposed, 1);
  assert.deepEqual(controller.snapshot().messages, []);
  await controller.send('Cursor');
  assert.deepEqual(seen, ['codex', 'cursor']);
});

test('initialization errors appear in the transcript and can be retried', async () => {
  let attempts = 0;
  const controller = new ChatController(selection, async () => {
    if (++attempts === 1) throw new Error('Please sign in');
    return { async run() {}, async dispose() {} };
  }, () => {});
  await controller.send('first');
  assert.equal(controller.snapshot().messages.at(-1)?.role, 'error');
  assert.equal(controller.snapshot().messages.at(-1)?.text, 'Please sign in');
  assert.equal(controller.snapshot().busy, false);
  await controller.send('retry');
  assert.equal(attempts, 2);
});

test('reset waits for cleanup and blocks new work until disposal completes', async () => {
  const cleanup = deferred();
  const controller = new ChatController(selection, async () => ({
    async run() {}, async dispose() { await cleanup.promise; },
  }), () => {});
  await controller.send('hello');
  const resetting = controller.reset();
  await assert.rejects(controller.send('during reset'), /実行中/);
  cleanup.resolve();
  await resetting;
  assert.equal(controller.snapshot().busy, false);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('reset during an active turn forgets the old backend session before the next send', async () => {
  const entered = deferred();
  const resumes: Array<string | undefined> = [];
  const controller = new ChatController(selection, async (_selection, context) => {
    resumes.push(context?.resumeId);
    const first = resumes.length === 1;
    return {
      sessionId: first ? 'old-thread' : 'new-thread',
      async run(_prompt, signal) {
        if (!first) return;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async dispose() {},
    };
  }, () => {});
  const running = controller.send('old conversation');
  await entered.promise;
  await controller.reset();
  await running;
  assert.equal(controller.sessionId(), undefined);
  await controller.send('new conversation');
  assert.deepEqual(resumes, [undefined, undefined]);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['new conversation']);
  await controller.dispose();
});

test('session restoration blocks competing work and reset waits for it before cleanup', async () => {
  const entered = deferred();
  const loaded = deferred();
  let disposed = 0;
  let runs = 0;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'restoring-thread',
    async loadTranscript(emit) {
      entered.resolve();
      await loaded.promise;
      emit({ id: 'restored-answer', role: 'assistant', text: 'old history' });
    },
    async run() { runs++; },
    async dispose() { disposed++; },
  }), () => {});
  controller.prepareResume('restoring-thread');
  const opening = controller.openSession();
  await entered.promise;
  assert.equal(controller.snapshot().busy, true);
  await assert.rejects(controller.send('overlap'), /実行中/);
  await assert.rejects(controller.applyMode('plan'), /実行中/);
  const resetting = controller.reset();
  assert.equal(disposed, 0, 'restore must settle before its session is disposed');
  loaded.resolve();
  await Promise.all([opening, resetting]);
  assert.equal(disposed, 1);
  assert.equal(runs, 0);
  assert.equal(controller.sessionId(), undefined);
  assert.equal(controller.snapshot().busy, false);
  assert.deepEqual(controller.snapshot().messages, []);
});

test('failed session restoration leaves queued input pending instead of resending it', async () => {
  const entered = deferred();
  const loaded = deferred();
  let runs = 0;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'restore-failure',
    async loadTranscript() {
      entered.resolve();
      await loaded.promise;
      throw new Error('session load failed');
    },
    async run() { runs++; },
    async dispose() {},
  }), () => {});
  controller.prepareResume('restore-failure');
  const opening = controller.openSession();
  await entered.promise;
  controller.enqueue('queued request');
  loaded.resolve();
  await opening;
  assert.equal(runs, 0);
  assert.equal(controller.snapshot().queue[0]?.text, 'queued request');
  assert.equal(controller.snapshot().status, 'error');
  assert.equal(controller.snapshot().busy, false);
  await controller.dispose();
});

test('a prompt immediately following a selection change waits for old-session cleanup', async () => {
  const cleanup = deferred();
  const providers: string[] = [];
  const controller = new ChatController(selection, async (options) => {
    providers.push(options.provider);
    return { async run() {}, async dispose() { await cleanup.promise; } };
  }, () => {});
  await controller.send('first');
  const next = { ...selection, provider: 'cursor' as const };
  const changing = controller.select(next);
  const sending = (async () => { await controller.select(next); await controller.send('immediate send'); })();
  cleanup.resolve();
  await Promise.all([changing, sending]);
  assert.deepEqual(providers, ['codex', 'cursor']);
  assert.deepEqual(controller.snapshot().messages.map((message) => message.text), ['immediate send']);
});

test('a closed session is replaced and the next send resumes its id', async () => {
  const seen: Array<string | undefined> = [];
  let created = 0;
  const controller = new ChatController(selection, async (_selection, context) => {
    created += 1;
    seen.push(context?.resumeId);
    const dead = created === 1;
    return {
      sessionId: 'thread-1',
      get closed() { return dead; },
      async run() { if (dead) throw new Error('Agent process exited (1).'); },
      async dispose() {},
    };
  }, () => {});
  await controller.send('first');
  assert.equal(controller.snapshot().messages.at(-1)?.role, 'error');
  await controller.send('second');
  assert.equal(created, 2);
  assert.equal(seen[0], undefined);
  assert.equal(seen[1], 'thread-1');
  assert.equal(controller.snapshot().status, 'idle');
});

test('updating the model for the next send keeps the conversation and restores a rejected change', async () => {
  let applied = '';
  const controller = new ChatController({ ...selection, provider: 'cursor', model: 'first' }, async () => ({
    async run() {},
    async dispose() {},
    setModel(next) {
      if (next.model === 'bad') throw new Error('rejected');
      applied = next.model;
    },
  }), () => {});
  await controller.send('hello');
  await controller.updateSelection({ ...selection, provider: 'cursor', model: 'next', modelParams: [{ id: 'effort', value: 'high' }] });
  assert.equal(applied, 'next');
  assert.equal(controller.snapshot().selection.model, 'next');
  assert.match(controller.snapshot().messages.map((message) => message.text).join('\n'), /hello/);
  await assert.rejects(() => controller.updateSelection({ ...selection, provider: 'cursor', model: 'bad' }), /rejected/);
  assert.equal(controller.snapshot().selection.model, 'next');
  assert.equal(controller.snapshot().selection.modelParams?.[0]?.value, 'high');
});

test('a running turn keeps the current model', async () => {
  const entered = deferred();
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('long');
  await entered.promise;
  await assert.rejects(() => controller.updateSelection({ ...selection, model: 'next' }), /実行が終わってから/);
  assert.equal(controller.snapshot().selection.model, '');
  controller.stop();
  await running;
});

test('selecting a different variant of the same model starts a fresh session', async () => {
  let disposed = 0;
  const options: Selection[] = [];
  const controller = new ChatController(selection, async (selected) => {
    options.push(selected);
    return { async run() {}, async dispose() { disposed++; } };
  }, () => {});
  await controller.send('first');
  const next = { ...selection, modelParams: [{ id: 'mode', value: 'variant' }] };
  await controller.select(next);
  assert.deepEqual(controller.snapshot().messages, []);
  await controller.send('second');
  assert.equal(disposed, 1);
  assert.deepEqual(options[1]?.modelParams, next.modelParams);
});

test('asynchronous model rejection keeps the UI selection and blocks sends until acknowledgement', async () => {
  const entered = deferred();
  const gate = deferred();
  const controller = new ChatController(selection, async () => ({
    async run() {},
    async setModel() { entered.resolve(); await gate.promise; throw new Error('IPC model failure'); },
    async dispose() {},
  }), () => {});
  await controller.send('initial');
  const changing = controller.updateSelection({ ...selection, model: 'other' });
  await entered.promise;
  assert.equal(controller.snapshot().selection.model, selection.model);
  await assert.rejects(controller.send('during change'), /実行中/);
  await assert.rejects(controller.updateSelection({ ...selection, model: 'third' }), /実行が終わって/);
  gate.resolve();
  await assert.rejects(changing, /IPC model failure/);
  assert.equal(controller.snapshot().selection.model, selection.model);
  await controller.send('after failure');
  assert.equal(controller.snapshot().turns.at(-1)?.status, 'completed');
});

test('a rejected mode change preserves the mode used by the next turn', async () => {
  const modes: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, _emit, _extras, turn) { modes.push(turn!.mode!); },
    async setMode() { throw new Error('mode rejected'); },
    async dispose() {},
  }), () => {});
  await controller.send('initial');
  await assert.rejects(controller.applyMode('plan'), /mode rejected/);
  await controller.send('follow-up');
  assert.deepEqual(modes, ['agent', 'agent']);
});
