import assert from 'node:assert/strict';
import type { ThreadItem } from '../../../src/providers/codex-items.js';
import { test } from 'node:test';
import { addUsage, codexMeta, codexUsage, lightMeta } from '../../../src/providers/details.js';

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
