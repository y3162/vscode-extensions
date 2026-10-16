import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import { mergeRegistrySessions } from '../src/session-index.js';
import { SessionRegistry } from '../src/session-registry.js';
import { presentChange } from '../src/view-state.js';
import type { Selection } from '../src/types.js';

const selection: Selection = { provider: 'cursor', cwd: '/workspace', model: 'composer-2.5' };

test('a busy chat stays listed after the front conversation changes', async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = new ChatController(selection, async () => ({
    sessionId: 'live-1',
    async run() { entered(); await gate; },
    async dispose() {},
  }), () => {});
  const registry = new SessionRegistry(first, 'agent');
  const running = first.send('investigate the registry');
  await started;
  first.rememberSession({ id: 'live-1', title: 'Investigate', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'cursor', cwd: '/workspace' });
  const second = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  registry.add({ key: 'next', controller: second, mode: 'agent' });
  registry.focus('next');
  assert.equal(registry.front, second);
  assert.equal(registry.runningCount(), 1);
  assert.equal(registry.activityFor('live-1'), 'running');
  const listed = mergeRegistrySessions(second.snapshot().sessions, registry.liveSummaries());
  assert.equal(listed.find((item) => item.id === 'live-1')?.activity, 'running');
  assert.equal(listed.find((item) => item.id === 'live-1')?.title, 'Investigate');
  first.setTerminals([{ processId: 'proc', command: 'sleep 30', status: 'running' }]);
  assert.equal(first.hasLiveTerminals(), true);
  first.setTerminals([{ processId: 'proc', command: 'sleep 30', status: 'exited' }]);
  assert.equal(first.hasLiveTerminals(), false);
  finish();
  await running;
  assert.equal(registry.activityFor('live-1'), 'idle');
  await first.dispose();
  await second.dispose();
});

test('a diff without a captured baseline is not reviewable', () => {
  const update = presentChange({ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1 }, ['/workspace']);
  assert.equal(update.canDiff, false);
  assert.equal(update.canRevert, false);
  assert.equal(update.additions, 1);
  const added = presentChange({ path: 'src/b.ts', kind: 'add', previousText: null, additions: 1, deletions: 0 }, ['/workspace']);
  assert.equal(added.canDiff, true);
});

test('late child and terminal updates stay with their original turn and release subscriptions', async () => {
  let listener: ((update: import('../src/types.js').AgentUpdate) => void) | undefined;
  let released = 0;
  let disposed = 0;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'late-session',
    subscribeBackgroundUpdates(emit) { listener = emit; return () => { released++; listener = undefined; }; },
    async run(prompt) {
      if (prompt === 'first') listener?.({ id: 'child:one', role: 'status', text: 'child', meta: { type: 'subagent', subagent: { id: 'one', name: 'One', status: 'running', background: true } } });
    },
    async dispose() { disposed++; },
  }), () => {});
  await controller.send('first');
  const parent = controller.snapshot().turns[0]!.id;
  await controller.hibernate();
  assert.equal(disposed, 0, 'an active child prevents hibernation even after its parent ends');
  await controller.send('second');
  listener?.({ id: 'child:one', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { id: 'one', name: 'One', status: 'completed', background: true, resultPreview: 'result' } } });
  const state = controller.snapshot();
  assert.equal(state.subagents.length, 1);
  assert.equal(state.subagents[0]?.parentTurnId, parent);
  assert.equal(state.messages.filter((item) => item.id === `${parent}:child:one`).length, 1);
  assert.equal(state.messages.find((item) => item.id === `${parent}:child:one`)?.text, 'done');
  await controller.hibernate();
  assert.equal(released, 1);
  assert.equal(disposed, 1);
  await controller.dispose();
});

test('restored sessions subscribe to background updates and update existing history cards', async () => {
  let emit: ((update: import('../src/types.js').AgentUpdate) => void) | undefined;
  const child = { id: 'restored-child', name: 'Child', status: 'running' as const, background: true as const };
  const controller = new ChatController(selection, async () => ({
    sessionId: 'restored',
    subscribeBackgroundUpdates(listener) { emit = listener; return () => { emit = undefined; }; },
    async loadTranscript(replay) { replay({ id: 'old-child-card', role: 'status', text: 'running', meta: { type: 'subagent', subagent: child } }); },
    async run() {}, async dispose() {},
  }), () => {});
  controller.prepareResume('restored');
  await controller.openSession();
  assert.equal(controller.hasLiveChildren(), true);
  assert.ok(emit);
  emit({ id: 'subagent:restored-child', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { ...child, status: 'completed', resultPreview: 'preserved result' } } });
  assert.equal(controller.snapshot().messages.length, 1);
  assert.equal(controller.snapshot().messages[0]?.id, 'old-child-card');
  assert.equal(controller.snapshot().subagents[0]?.status, 'completed');
  await controller.dispose();
  assert.equal(emit, undefined);
});
