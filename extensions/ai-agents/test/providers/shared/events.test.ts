import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUpdate } from '../../../src/providers/events.js';
import { usageDifference } from '../../../src/usage.js';

test('Codex command snapshots keep output and file changes keep paths', () => {
  assert.deepEqual(codexUpdate({
    id: 'shell', type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: 'passed', exit_code: 0,
  }), { id: 'shell', role: 'tool', text: 'completed: npm test\npassed' });
  assert.match(codexUpdate({ id: 'patch', type: 'file_change', status: 'completed', changes: [{ kind: 'add', path: 'src/main.ts' }] })!.text, /add: src\/main.ts/);
});

test('Codex errors, unknown items, and cache-write deltas stay explicit', () => {
  assert.equal(codexUpdate({ id: 'bad', type: 'error', message: 'boom' })?.role, 'error');
  assert.equal(codexUpdate({ id: 'mystery', type: 'future_item' } as never), undefined);
  assert.match(codexUpdate({ id: 'mcp', type: 'mcp_tool_call', status: 'failed', server: 'docs', tool: 'search', arguments: {}, error: { message: 'denied' } })?.text ?? '', /denied/);
  assert.match(codexUpdate({ id: 'web', type: 'web_search', query: 'protocol' })?.text ?? '', /protocol/);
  assert.match(codexUpdate({ id: 'todos', type: 'todo_list', items: [{ text: 'write tests', completed: false }, { text: 'done', completed: true }] })?.text ?? '', /○ write tests[\s\S]*✓ done/);
  assert.equal(codexUpdate({ id: 'reason', type: 'reasoning', text: 'hidden' }), undefined);
  assert.equal(codexUpdate({ id: 'mcp-ok', type: 'mcp_tool_call', status: 'completed', server: 'docs', tool: 'search', arguments: {} })?.text.includes('undefined'), false);
  assert.equal(codexUpdate({ id: 'empty-files', type: 'file_change', status: 'completed', changes: [] })?.text, 'completed\n');
  const delta = usageDifference(
    { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 2, totalTokens: 14 },
    { inputTokens: 4, outputTokens: 1, cachedInputTokens: 1, cacheWriteInputTokens: 1, totalTokens: 5 },
  );
  assert.equal(delta?.cacheWriteInputTokens, 1);
  assert.equal(delta?.cachedInputTokens, 2);
  assert.equal(usageDifference(
    { inputTokens: 3, outputTokens: 1, cacheWriteInputTokens: 0 },
    { inputTokens: 8, outputTokens: 1, cacheWriteInputTokens: 4 },
  ), undefined);
});
