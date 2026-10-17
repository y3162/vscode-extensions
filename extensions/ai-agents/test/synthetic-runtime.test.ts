import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

type EventRow = { method: string; params: any; item?: any };
type Synthetic = {
  parallelChildren(): EventRow[];
  duplicateChild(): EventRow[];
  reorderedChild(): EventRow[];
  delayedChild(): { immediate: EventRow[]; late: EventRow[] };
  usageSnapshots(): EventRow[];
  acpTasks(): EventRow[];
  acpChildOutcomes(): EventRow[];
  nativeMove(cwd: string): EventRow[];
};
const synthetic = createRequire(__filename)('./fixtures/synthetic-runtime.cjs') as Synthetic;

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

test('parallel child events keep two ids, duplicate start items, and empty wait receivers', () => {
  const events = synthetic.parallelChildren();
  const started = events.filter((event) => event.params.item?.type === 'subAgentActivity' && event.params.item.kind === 'started');
  const finished = events.filter((event) => event.params.item?.type === 'subAgentActivity' && event.params.item.kind === 'completed');
  assert.equal(started.length, 4);
  assert.equal(finished.length, 4);
  assert.deepEqual(started.map((event) => event.method), ['item/started', 'item/completed', 'item/started', 'item/completed']);
  const waits = events.filter((event) => event.params.item?.tool === 'wait');
  assert.equal(waits.length, 4);
  assert.ok(waits.every((event) => event.params.item.receiverThreadIds.length === 0 && Object.keys(event.params.item.agentsStates).length === 0));
  const ids = new Set(events.flatMap((event) => event.params.item?.agentThreadId ? [event.params.item.agentThreadId] : []));
  assert.deepEqual([...ids].sort(), ['child-alpha', 'child-beta']);
  assert.ok(events.every((event) => !JSON.stringify(event).includes('2026-10-16')));
});

test('a completed start item is distinct from the later completion item', () => {
  const events = synthetic.parallelChildren();
  const alpha = events.filter((event) => event.params.item?.agentThreadId === 'child-alpha' || event.params.threadId === 'child-alpha');
  const startCompletion = must(alpha.find((event) => event.method === 'item/completed' && event.params.item?.kind === 'started'), 'start completion');
  const realCompletion = must(alpha.find((event) => event.params.item?.kind === 'completed'), 'real completion');
  assert.notEqual(startCompletion.params.item.id, realCompletion.params.item.id);
  assert.ok(events.indexOf(startCompletion) < events.indexOf(realCompletion));
});

test('child deltas stay on the child thread and concatenate to the preview', () => {
  const events = synthetic.parallelChildren();
  const deltas = events.filter((event) => event.method === 'item/agentMessage/delta' && event.params.threadId === 'child-alpha');
  assert.equal(deltas.map((event) => event.params.delta).join(''), 'alpha result');
  assert.ok(deltas.every((event) => event.params.threadId !== 'thread-1'));
  const final = must(events.find((event) => event.params.threadId === 'child-alpha' && event.params.item?.phase === 'final_answer'), 'final');
  assert.equal(final.params.item.text, 'alpha result');
});

test('ACP task requests use the same tool call id as the pending card', () => {
  const events = synthetic.acpTasks();
  const pending = events.filter((event) => event.params.update?.sessionUpdate === 'tool_call');
  const requests = events.filter((event) => event.method === 'request');
  assert.deepEqual(pending.map((event) => event.params.update.toolCallId), ['tool-alpha', 'tool-beta']);
  assert.deepEqual(requests.map((event) => event.params.params.toolCallId), ['tool-alpha', 'tool-beta']);
  assert.ok(requests.every((event) => event.params.method === 'cursor/task' && event.params.params.model === 'composer-2.5-fast' && event.params.params.agentId));
  const pendingBeta = must(pending[1], 'pending beta');
  const requestAlpha = must(requests[0], 'task request');
  assert.ok(events.indexOf(pendingBeta) < events.indexOf(requestAlpha));
  assert.equal(requestAlpha.params.params.subagentType.custom.unspecified !== undefined, true);
});

test('ACP failure and cancellation are separate tool calls', () => {
  const events = synthetic.acpChildOutcomes();
  const updates = events.filter((event) => event.params.update?.sessionUpdate === 'tool_call_update');
  assert.deepEqual(updates.map((event) => [event.params.update.toolCallId, event.params.update.status]), [
    ['tool-failed', 'failed'],
    ['tool-cancelled', 'cancelled'],
  ]);
});

test('native move uses an update kind with move_path', () => {
  const events = synthetic.nativeMove('/workspace');
  const change = must(must(events[1], 'completed move').item, 'move item').changes[0];
  assert.equal(change.kind.type, 'update');
  assert.equal(change.kind.move_path, '/workspace/b.txt');
  assert.equal(change.path, '/workspace/a.txt');
  assert.match(change.diff, /-alpha\n\+beta/);
  assert.equal(must(events[0], 'started move').item.status, 'inProgress');
  assert.equal(must(events[1], 'completed move').item.status, 'completed');
});

test('duplicate and reordered child scripts keep a single child id', () => {
  const duplicate = synthetic.duplicateChild();
  assert.equal(new Set(duplicate.map((event) => event.params.item.agentThreadId)).size, 1);
  assert.equal(duplicate.filter((event) => event.params.item.kind === 'started').length, 3);
  const reordered = synthetic.reorderedChild();
  const first = must(reordered[0], 'completed first');
  const second = must(reordered[1], 'started second');
  assert.equal(first.params.item.kind, 'completed');
  assert.equal(second.params.item.kind, 'started');
  assert.equal(first.params.item.agentThreadId, second.params.item.agentThreadId);
});

test('a delayed child completion is separate from the parent turn events', () => {
  const delayed = synthetic.delayedChild();
  assert.equal(delayed.immediate.some((event) => event.method === 'turn/completed'), false);
  const late = must(delayed.late[0], 'late completion');
  const parent = must(delayed.immediate[0], 'parent start');
  assert.equal(late.method, 'turn/completed');
  assert.equal(late.params.threadId, 'child-late');
  assert.equal(parent.params.threadId, 'thread-1');
});

test('usage snapshots include cache writes and a later smaller total', () => {
  const first = must(synthetic.usageSnapshots()[0], 'first usage');
  const second = must(synthetic.usageSnapshots()[1], 'second usage');
  assert.equal(first.params.tokenUsage.total.cacheWriteInputTokens, 4);
  assert.equal(first.params.tokenUsage.total.cachedInputTokens, 8);
  assert.ok(second.params.tokenUsage.total.inputTokens < first.params.tokenUsage.total.inputTokens);
  assert.equal(second.params.tokenUsage.total.cacheWriteInputTokens, 1);
});
