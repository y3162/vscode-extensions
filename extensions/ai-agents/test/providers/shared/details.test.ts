import assert from 'node:assert/strict';
import type { SDKMessage } from '@cursor/sdk';
import type { ThreadItem } from '@openai/codex-sdk';
import { test } from 'node:test';
import { addUsage, codexMeta, codexUsage, cursorMeta, lightMeta } from '../../../src/providers/details.js';

const ids = { agent_id: 'agent', run_id: 'run' };

function tool(name: string, extra: { args?: unknown; result?: unknown; status?: 'running' | 'completed' | 'error'; call_id?: string } = {}): SDKMessage {
  return { ...ids, type: 'tool_call', call_id: extra.call_id ?? 'call', name, status: extra.status ?? 'completed', args: extra.args, result: extra.result };
}

test('usage totals keep optional fields only when both samples define them', () => {
  assert.deepEqual(codexUsage({ input_tokens: 3, cached_input_tokens: 1, output_tokens: 4, reasoning_output_tokens: 2 }), {
    inputTokens: 3, outputTokens: 4, cachedInputTokens: 1, cacheWriteInputTokens: undefined, reasoningTokens: 2, totalTokens: 7,
  });
  assert.equal(codexUsage({
    input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 8, output_tokens: 1, reasoning_output_tokens: 0,
  }).cacheWriteInputTokens, 8);
  assert.deepEqual(addUsage(null, { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, totalTokens: 5 }), {
    inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, totalTokens: 5,
  });
  const dropped = addUsage(
    { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1 },
    { inputTokens: 2, outputTokens: 3, cachedInputTokens: 2, cacheWriteInputTokens: 4, reasoningTokens: 5, totalTokens: 9 },
  );
  assert.equal(dropped.cachedInputTokens, 3);
  assert.equal(dropped.cacheWriteInputTokens, undefined);
  assert.equal(dropped.reasoningTokens, undefined);
  assert.equal(dropped.totalTokens, undefined);
  assert.equal(addUsage(
    { inputTokens: 1, outputTokens: 1, cacheWriteInputTokens: 1, totalTokens: 2 },
    { inputTokens: 1, outputTokens: 1, cacheWriteInputTokens: 2, totalTokens: 2 },
  ).cacheWriteInputTokens, 3);
});

test('Codex file and todo metadata keeps move paths and drops empty patches', () => {
  const files = codexMeta({
    id: 'patch', type: 'file_change', status: 'completed',
    changes: [
      { path: 'from.ts', kind: { type: 'update', move_path: 'to.ts' }, diff: '@@', previousText: 'old' },
      { path: 'old.ts', kind: { type: 'rename', movePath: 'src.ts' }, previousText: null },
      { path: 'x.ts', kind: { type: 'mystery', move_path: 'y.ts' }, previousText: 4, diff: 1 },
      { path: 'z.ts', kind: 'delete' },
    ],
  } as ThreadItem);
  assert.equal(files?.type, 'files');
  assert.equal(files?.files?.[0]?.path, 'to.ts');
  assert.equal(files?.files?.[0]?.oldPath, 'from.ts');
  assert.equal(files?.files?.[0]?.diff, '@@');
  assert.equal(files?.files?.[0]?.previousText, 'old');
  assert.equal(files?.files?.[1]?.oldPath, 'src.ts');
  assert.equal(files?.files?.[1]?.previousText, null);
  assert.equal(files?.files?.[2]?.oldPath, 'y.ts');
  assert.equal('diff' in (files?.files?.[2] ?? {}), false);
  assert.equal('previousText' in (files?.files?.[2] ?? {}), false);
  assert.equal(files?.files?.[3]?.kind, 'delete');
  assert.equal(codexMeta({ id: 'empty', type: 'file_change', status: 'failed', changes: [] }), undefined);
  assert.deepEqual(codexMeta({ id: 'todos', type: 'todo_list', items: [{ text: 'done', completed: true }, { text: 'left', completed: false }] }), {
    type: 'todo', todos: [{ content: 'done', status: 'completed' }, { content: 'left', status: 'pending' }],
  });
  assert.equal(codexMeta({ id: 'msg', type: 'agent_message', text: 'hi' }), undefined);
});

test('Cursor metadata reads nested tool results and ignores non-file tools', () => {
  assert.deepEqual(cursorMeta({ ...ids, type: 'thinking', text: 'hmm' }), { type: 'thinking', append: true });
  assert.equal(cursorMeta({ ...ids, type: 'thinking', text: '' }), undefined);
  assert.equal(cursorMeta({ ...ids, type: 'usage', usage: {
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 5,
  } })?.usage?.reasoningTokens, undefined);
  assert.equal(cursorMeta({ ...ids, type: 'usage', usage: {
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 5, reasoningTokens: 6,
  } })?.usage?.scope, 'run');
  assert.equal(cursorMeta({ ...ids, type: 'task', text: 'ship' })?.task, 'ship');
  assert.equal(cursorMeta({ ...ids, type: 'task' }), undefined);
  assert.equal(cursorMeta({ ...ids, type: 'system' }), undefined);

  const todos = cursorMeta(tool('updateTodos', { args: { todos: [
    { content: 'a', status: 'completed' }, { text: 'b' }, { content: '' }, 'nope', { content: 'c', status: 1 },
  ] } }));
  assert.deepEqual(todos, { type: 'todo', todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' },
  ] });
  assert.equal(cursorMeta(tool('update_todos', {
    args: { todos: 'no' }, result: { status: 'success', value: { todos: [{ content: 'from-value' }] } },
  }))?.todos?.[0]?.content, 'from-value');
  assert.equal(cursorMeta(tool('updateTodos', { args: {}, result: { status: 'error', todos: [{ content: 'from-result' }] } }))?.todos?.[0]?.content, 'from-result');
  assert.equal(cursorMeta(tool('updateTodos', { args: { todos: [{ content: '' }] } })), undefined);
  assert.equal(cursorMeta(tool('updateTodos', { args: {}, result: {} })), undefined, 'a tool without todos does not invent an empty update');
  assert.equal(cursorMeta(tool('createPlan', { args: { plan: '  ' } })), undefined);
  assert.equal(cursorMeta(tool('createPlan', { args: { plan: 'Do it' } }))?.plan?.source, 'sdk-createPlan');
  assert.equal(cursorMeta(tool('createPlan', { result: { status: 'success', value: { plan: 'from value' } } }))?.plan?.markdown, 'from value');
  assert.equal(cursorMeta(tool('createPlan', { args: {}, result: {} })), undefined, 'a missing plan remains absent');

  const named = cursorMeta(tool('task', {
    status: 'running', args: { description: 'Explore', prompt: 'look', subagentType: { name: 'explore' } },
    result: { status: 'success', value: { isBackground: false, durationMs: 12, resultSuffix: 'x'.repeat(600) } },
  }));
  assert.equal(named?.subagent?.name, 'explore');
  assert.equal(named?.subagent?.task, 'look');
  assert.equal(named?.subagent?.status, 'running');
  assert.equal(named?.subagent?.background, false);
  assert.equal(named?.subagent?.durationMs, 12);
  assert.equal(named?.subagent?.resultPreview?.length, 500);
  const kind = cursorMeta(tool('task', { status: 'error', args: { description: 'Fallback', subagentType: { kind: 'search' } } }));
  assert.equal(kind?.subagent?.name, 'search');
  assert.equal(kind?.subagent?.task, 'Fallback');
  assert.equal(kind?.subagent?.status, 'error');
  assert.equal(kind?.subagent?.background, 'unknown');
  assert.equal(cursorMeta(tool('task', { args: { description: 'Plain' } }))?.subagent?.status, 'completed');
  assert.equal(cursorMeta(tool('task'))?.subagent?.task, 'task', 'the event name is used when task description is absent');

  assert.equal(cursorMeta(tool('generateImage', { result: { status: 'success', value: { file_path: 'a.png' } } }))?.imagePath, 'a.png');
  assert.equal(cursorMeta(tool('generateImage', { result: { filePath: 'b.png', status: 'success', value: { lines: 1 } } }))?.imagePath, 'b.png');
  assert.equal(cursorMeta(tool('generateImage', { args: { filePath: 'c.png' }, result: { status: 'error' } }))?.imagePath, 'c.png');
  assert.equal(cursorMeta(tool('generateImage', { result: { success: { status: 'success', value: { path: 'nested.png' } } } }))?.imagePath, 'nested.png');
  assert.equal(cursorMeta(tool('generateImage', { result: { success: { value: { path: 'fallback.png' } }, value: 'nope' } }))?.imagePath, 'fallback.png');
  assert.equal(cursorMeta(tool('generateImage', { result: { value: { path: 'direct.png' } } }))?.imagePath, 'direct.png');
  assert.equal(cursorMeta(tool('generateImage', { result: { status: 'success', value: 'text' } })), undefined);
  assert.equal(cursorMeta(tool('generateImage', { result: { path: '', file_path: '' } })), undefined);
  assert.equal(cursorMeta(tool('generateImage', { result: null })), undefined);

  const edit = cursorMeta(tool('Edit', { args: { path: 'a.ts' }, result: { status: 'success', value: { diffString: '+a', linesAdded: 2, linesRemoved: 1 } } }));
  assert.equal(edit?.files?.[0]?.kind, 'update');
  assert.equal(edit?.files?.[0]?.additions, 2);
  assert.equal(edit?.files?.[0]?.deletions, 1);
  const created = cursorMeta(tool('Write', { args: { file_path: 'b.ts' }, result: { value: { linesCreated: 3 } } }));
  assert.equal(created?.files?.[0]?.kind, 'add');
  assert.equal(created?.files?.[0]?.additions, 3);
  assert.equal('deletions' in (created?.files?.[0] ?? {}), false);
  const removed = cursorMeta(tool('Delete', { result: { diffString: 'diff', value: {} } }));
  assert.equal(removed?.files?.[0]?.path, 'patch');
  assert.equal(removed?.files?.[0]?.kind, 'delete');
  assert.equal(removed?.files?.[0]?.diff, 'diff');
  assert.equal(cursorMeta(tool('applyAgentDiff', { args: { filePath: 'c.ts' } }))?.files?.[0]?.path, 'c.ts');
  assert.equal(cursorMeta(tool('Read', { args: { path: 'src/a.ts' }, result: { status: 'success', value: { content: 'x' } } })), undefined);
  assert.equal(cursorMeta(tool('Edit', { args: {}, result: {} })), undefined);
});

test('light metadata drops stored baselines and previews a diff only when needed', () => {
  assert.equal(lightMeta(undefined), undefined);
  const todo = { type: 'todo' as const, todos: [{ content: 'a', status: 'pending' }] };
  assert.equal(lightMeta(todo), todo);
  assert.deepEqual(lightMeta({ type: 'files' }), { type: 'files' });
  const light = lightMeta({
    type: 'files',
    files: [
      { path: 'a.ts', kind: 'update', previousText: 'old', preview: [{ kind: 'add', line: 1, text: 'kept' }], diff: 'ignored' },
      { path: 'b.ts', kind: 'update', previousText: null, diff: 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n' },
      { path: 'c.ts', kind: 'add' },
    ],
  });
  assert.equal('previousText' in (light?.files?.[0] ?? {}), false);
  assert.equal(light?.files?.[0]?.preview?.[0]?.text, 'kept');
  assert.equal('diff' in (light?.files?.[0] ?? {}), false);
  assert.deepEqual(light?.files?.[1]?.preview?.map((line) => line.text), ['old', 'new']);
  assert.equal(light?.files?.[2]?.preview, undefined);
});

test('light subagent metadata keeps optional progress and error only when present', () => {
  const base = { id: 'child', name: 'Explore', status: 'running' as const, background: false as const };
  assert.deepEqual(lightMeta({ type: 'subagent', subagent: base })?.subagent, base);
  const detailed = lightMeta({ type: 'subagent', subagent: {
    ...base, task: 'look', progress: 'reading', error: 'failed', resultPreview: 'found',
  } })?.subagent;
  assert.equal(detailed?.task, 'look');
  assert.equal(detailed?.progress, 'reading');
  assert.equal(detailed?.error, 'failed');
  assert.equal(detailed?.resultPreview, 'found');
  const longTask = lightMeta({ type: 'subagent', subagent: { ...base, task: 'x'.repeat(12001) } })?.subagent;
  assert.equal(longTask?.task?.length, 12000);
  assert.equal(longTask?.taskOmitted, true);
});
