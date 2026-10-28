import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { lineChangeCounts, normalizeChangeKind, parseUnifiedDiff, previewTextDiff, previewUnifiedDiff, previousTextFromDiff } from '../../src/diff-stats.js';
import { buildPrompt, requestBuild } from '../../src/plan-state.js';
import { emptyPlanState, type Selection } from '../../src/types.js';
import { buildTurns } from '../../src/webview/turns.js';
import type { ViewMessage } from '../../src/protocol.js';

const selection: Selection = { provider: 'cursor', cwd: '/workspace', model: 'composer-2.5' };

test('plan capture stops in ready and build rejects a second start and a stale revision', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'plan', role: 'status', text: 'Do the thing', meta: { type: 'plan', plan: { markdown: 'Do the thing', source: 'sdk-createPlan', todos: [{ content: 'Edit', status: 'pending' }] } } });
        emit({ id: 'assistant-1', role: 'assistant', text: 'Plan ready' });
      } else emit({ id: 'assistant-1', role: 'assistant', text: `built ${turn?.selection.model}` });
    },
    async dispose() {},
  }), () => {});
  controller.setModePreference('plan');
  await controller.send('plan this', undefined, { intent: 'plan', mode: 'plan', selection });
  const ready = controller.snapshot().plan;
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.current?.markdown, 'Do the thing');
  assert.equal(ready.current?.revision, 1);
  const first = controller.build(ready.current!.id, 1, { ...selection, model: 'composer-2' });
  const second = controller.build(ready.current!.id, 1, selection);
  await first;
  await second;
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  assert.equal(controller.snapshot().messages.filter((message) => message.role === 'assistant' && message.text === 'built composer-2').length, 1);
  const refused = requestBuild(controller.snapshot().plan, ready.current!.id, 1, selection);
  assert.equal('error' in refused, true);
});

test('a failed revision keeps the previous plan buildable', async () => {
  let calls = 0;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit, _extras, turn) {
      calls += 1;
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: 'First', meta: { type: 'plan', plan: { markdown: 'First', source: 'assistant-text' } } });
      else throw new Error('revision failed');
    },
    async dispose() {},
  }), () => {});
  await controller.send('plan', undefined, { intent: 'plan', mode: 'plan', selection });
  const id = controller.snapshot().plan.current?.id;
  await controller.send('change it', undefined, { intent: 'revise', mode: 'plan', selection });
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().plan.current?.markdown, 'First');
  assert.equal(controller.snapshot().plan.current?.id, id);
  assert.equal(calls, 2);
});

test('a cancelled revision keeps the previous plan and the chosen build model', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'plan', role: 'status', text: 'First', meta: { type: 'plan', plan: { markdown: 'First', source: 'assistant-text' } } });
        return;
      }
      if (_prompt === 'change it') {
        emit({ id: 'plan', role: 'status', text: 'Partial', meta: { type: 'plan', plan: { markdown: 'Partial', source: 'assistant-text' } } });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      emit({ id: 'plan', role: 'status', text: 'Second', meta: { type: 'plan', plan: { markdown: 'Second', source: 'assistant-text' } } });
    },
    async dispose() {},
  }), () => {});
  await controller.send('plan', undefined, { intent: 'plan', mode: 'plan', selection });
  const id = controller.snapshot().plan.current?.id;
  controller.setBuildModel({ ...selection, model: 'composer-2' }, 'Composer 2');
  const revising = controller.send('change it', undefined, { intent: 'revise', mode: 'plan', selection });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const wait = () => {
      if (controller.snapshot().plan.draft?.markdown === 'Partial') resolve();
      else if (Date.now() > deadline) reject(new Error('draft was not staged'));
      else setTimeout(wait, 10);
    };
    wait();
  });
  controller.stop();
  await revising;
  const plan = controller.snapshot().plan;
  assert.equal(plan.phase, 'ready');
  assert.equal(plan.current?.markdown, 'First');
  assert.equal(plan.current?.id, id);
  assert.equal(plan.current?.revision, 1);
  assert.equal(plan.build?.selection.model, 'composer-2');
  assert.equal(plan.build?.label, 'Composer 2');
  await controller.send('rewrite', undefined, { intent: 'revise', mode: 'plan', selection });
  assert.equal(controller.snapshot().plan.current?.markdown, 'Second');
  assert.equal(controller.snapshot().plan.current?.revision, 2);
  assert.equal(controller.snapshot().plan.build?.selection.model, 'composer-2');
  assert.equal(controller.snapshot().plan.build?.label, 'Composer 2');
});

test('cancelling the first plan does not publish a partial draft', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emit) {
      emit({ id: 'plan', role: 'status', text: 'Partial', meta: { type: 'plan', plan: { markdown: 'Partial', source: 'assistant-text' } } });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async dispose() {},
  }), () => {});
  const pending = controller.send('plan', undefined, { intent: 'plan', mode: 'plan', selection });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const wait = () => {
      if (controller.snapshot().plan.draft?.markdown === 'Partial') resolve();
      else if (Date.now() > deadline) reject(new Error('draft was not staged'));
      else setTimeout(wait, 10);
    };
    wait();
  });
  controller.stop();
  await pending;
  assert.equal(controller.snapshot().plan.phase, 'idle');
  assert.equal(controller.snapshot().plan.current, undefined);
});

test('an implemented plan stays implemented after restore and a busy build does not stick', async () => {
  let entered!: () => void;
  let finishWait!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finishWait = resolve; });
  const controller = new ChatController(selection, async () => ({
    sessionId: 'session-1',
    async run(prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') {
        emit({ id: 'plan', role: 'status', text: 'First', meta: { type: 'plan', plan: { markdown: 'First', source: 'sdk-createPlan' } } });
        return;
      }
      if (prompt === 'wait') {
        entered();
        await gate;
      }
    },
    async dispose() {},
  }), () => {});
  await controller.send('plan', undefined, { intent: 'plan', mode: 'plan', selection });
  const current = controller.snapshot().plan.current!;
  const restored = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  restored.restorePlan({ ...controller.snapshot().plan, phase: 'implemented', current: { ...current, revision: 1 } });
  assert.equal(restored.snapshot().plan.phase, 'implemented');
  assert.equal(restored.snapshot().plan.current?.restored, true);
  await assert.rejects(() => restored.build(current.id, 1, selection), /準備ができていません/);
  const waiting = controller.send('wait', undefined, { intent: 'chat', mode: 'agent', selection });
  await started;
  await assert.rejects(() => controller.build(current.id, 1, selection), /実行中/);
  assert.equal(controller.snapshot().plan.phase, 'ready');
  finishWait();
  await waiting;
});

test('build prompt keeps the plan text and file kinds accept object form', () => {
  const prompt = buildPrompt({ id: 'p', revision: 2, markdown: 'Keep this', todos: [{ content: 'Step', status: 'pending' }], source: 'sdk-createPlan', createdAt: 1 });
  assert.match(prompt, /revision 2/);
  assert.match(prompt, /Do not create a new plan/);
  assert.match(prompt, /Keep this/);
  assert.equal(normalizeChangeKind({ type: 'add' }).kind, 'add');
  assert.deepEqual(normalizeChangeKind({ type: 'rename', move_path: 'old.ts' }), { kind: 'rename', oldPath: 'old.ts' });
  assert.equal(normalizeChangeKind('delete').kind, 'delete');
  const parsed = parseUnifiedDiff('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(parsed[0]?.additions, 1);
  assert.equal(parsed[0]?.deletions, 1);
  assert.deepEqual(lineChangeCounts('a\n', 'a\nb\n'), { additions: 1, deletions: 0 });
  assert.equal(emptyPlanState().phase, 'idle');
  assert.equal(previousTextFromDiff('diff --git a/n.ts b/n.ts\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+a\n', 'add'), null);
  assert.equal(previousTextFromDiff('diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n', 'delete'), 'a\n');
  assert.equal(previousTextFromDiff('diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n\\ No newline at end of file\n', 'delete'), 'a');
  assert.equal(previousTextFromDiff('diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\r\n', 'delete'), 'a\r\n');
  const crlfDeletion = parseUnifiedDiff('diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\r\n')[0]?.diff;
  assert.equal(crlfDeletion ? previousTextFromDiff(crlfDeletion, 'delete') : undefined, 'a\r\n');
  assert.equal(previousTextFromDiff('diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ b/n.ts\n@@ -1 +1 @@\n-a\n+b\n', 'update'), undefined);
  assert.deepEqual(previewTextDiff('1234', '1234\n'), [
    { kind: 'context', line: 1, text: '1234' },
    { kind: 'eof', text: 'Newline at end of file' },
  ]);
  const preview = previewUnifiedDiff('diff --git a/README.md b/README.md\nindex 123..456 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n');
  assert.deepEqual(preview.map((line) => line.text), ['context', 'old', 'new']);
  assert.equal(preview.some((line) => line.text.includes('README.md')), false);
});

test('an earlier assistant segment stays in the log when the final answer comes after tools', () => {
  const read: ViewMessage = { id: 'tool', role: 'tool', text: 'completed: Read src/a.ts', tool: { kind: 'read', name: 'Read', status: 'completed', target: 'src/a.ts' } };
  const turns = buildTurns([
    { id: 'user', role: 'user', text: 'Fix', at: 1_000 },
    { id: 'early', role: 'assistant', text: 'Looking', at: 1_100 },
    read,
    { id: 'late', role: 'assistant', text: 'Done', final: true, at: 2_000 },
  ], false, false, [{ id: 'user', startedAt: 1_000, endedAt: 4_000, waitMs: 500, status: 'completed', intent: 'chat' }]);
  assert.equal(turns[0]?.answer?.text, 'Done');
  assert.equal(turns[0]?.log.some((segment) => segment.type === 'text' && segment.text === 'Looking'), true);
  assert.equal(turns[0]?.endedAt, 4_000);
  assert.equal(turns[0]?.waitMs, 500);
});

test('failed or stopped revision of an implemented plan never re-enables its old Build', async () => {
  const { beginPlanning, stageDraft, commitDraft, finishBuild, planningFailed } = await import('../../src/plan-state.js');
  const original = finishBuild(commitDraft(stageDraft(beginPlanning(emptyPlanState()), { markdown: 'original', source: 'assistant-text' }), selection), 'completed');
  for (const error of [undefined, 'revision failed']) {
    const revised = planningFailed(stageDraft(beginPlanning(original), { markdown: 'partial', source: 'assistant-text' }), error);
    assert.equal(revised.phase, 'implemented');
    assert.equal(revised.current?.markdown, 'original');
    assert.equal(revised.current?.revision, 1);
    assert.equal('error' in requestBuild(revised, revised.current!.id, 1, selection), true);
  }
  const successful = commitDraft(stageDraft(beginPlanning(original), { markdown: 'revised', source: 'assistant-text' }), selection);
  assert.equal(successful.phase, 'ready');
  assert.equal(successful.current?.revision, 2);
  assert.equal('error' in requestBuild(successful, successful.current!.id, 2, selection), false);
});

test('Build awaits model acknowledgement, preserves the plan on rejection, and can retry', async () => {
  let rejectModel = true;
  let builds = 0;
  const controller = new ChatController(selection, async () => ({
    sessionId: 'same-session',
    async setModel() { await Promise.resolve(); if (rejectModel) throw new Error('model IPC rejected'); },
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: 'Plan', meta: { type: 'plan', plan: { markdown: 'Plan', source: 'assistant-text' } } });
      else { builds++; assert.equal(turn?.mode, 'agent'); emit({ id: 'answer', role: 'assistant', text: 'Built' }); }
    },
    async dispose() {},
  }), () => {});
  controller.setModePreference('plan');
  await controller.send('plan');
  const plan = controller.snapshot().plan.current!;
  await controller.build(plan.id, plan.revision, { ...selection, model: 'other-model' });
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().selection.model, selection.model);
  assert.equal(builds, 0);
  assert.ok(controller.snapshot().messages.some((message) => message.role === 'error' && /model IPC rejected/.test(message.text)));
  rejectModel = false;
  await controller.build(plan.id, plan.revision, { ...selection, model: 'other-model' });
  assert.equal(controller.snapshot().plan.phase, 'implemented');
  assert.equal(controller.snapshot().selection.model, 'other-model');
  assert.equal(controller.sessionId(), 'same-session');
  assert.equal(builds, 1);
});

test('Stop during Build model acknowledgement never launches implementation', async () => {
  let acknowledge!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
  let builds = 0;
  const controller = new ChatController(selection, async () => ({
    async setModel() { entered(); await gate; },
    async run(_prompt, _signal, emit, _extras, turn) {
      if (turn?.intent === 'plan') emit({ id: 'plan', role: 'status', text: 'Plan', meta: { type: 'plan', plan: { markdown: 'Plan', source: 'assistant-text' } } });
      else builds++;
    },
    async dispose() {},
  }), () => {});
  controller.setModePreference('plan');
  await controller.send('plan');
  const plan = controller.snapshot().plan.current!;
  const build = controller.build(plan.id, plan.revision, { ...selection, model: 'other-model' });
  await waiting;
  controller.stop();
  acknowledge();
  await build;
  assert.equal(builds, 0);
  assert.equal(controller.snapshot().plan.phase, 'ready');
  assert.equal(controller.snapshot().selection.model, 'other-model');
  assert.equal(controller.snapshot().turns.at(-1)?.status, 'cancelled');
});
