import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import { lineChangeCounts, normalizeChangeKind, parseUnifiedDiff } from '../src/diff-stats.js';
import { buildPrompt, requestBuild } from '../src/plan-state.js';
import { emptyPlanState, type Selection } from '../src/types.js';
import { buildTurns } from '../src/webview/turns.js';
import type { ViewMessage } from '../src/protocol.js';

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
  assert.match(controller.snapshot().messages.map((message) => message.text).join('\n'), /built composer-2/);
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

test('cursor file metadata reads result.value and ignores reads', async () => {
  const { cursorMeta } = await import('../src/providers/details.js');
  const base = { agent_id: 'a', run_id: 'r', call_id: 'c', status: 'completed' as const };
  const edit = cursorMeta({
    ...base, type: 'tool_call', name: 'edit', args: { path: 'src/a.ts' },
    result: { status: 'success', value: { linesAdded: 4, linesRemoved: 1, diffString: '+a' } },
  });
  assert.equal(edit?.type, 'files');
  assert.equal(edit?.files?.[0]?.additions, 4);
  assert.equal(edit?.files?.[0]?.deletions, 1);
  const read = cursorMeta({ ...base, type: 'tool_call', name: 'read', args: { path: 'src/a.ts' }, result: { status: 'success', value: { content: 'x' } } });
  assert.equal(read, undefined);
  const task = cursorMeta({
    ...base, type: 'tool_call', name: 'task', args: { description: 'Explore', prompt: 'look' },
    result: { status: 'success', value: { isBackground: false, durationMs: 12 } },
  });
  assert.equal(task?.subagent?.background, false);
  assert.equal(task?.subagent?.status, 'completed');
});
