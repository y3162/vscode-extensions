import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUpdate, cursorUpdate } from '../src/providers/events.js';
import { usageDifference } from '../src/usage.js';

test('Codex command snapshots keep output and file changes keep paths', () => {
  assert.deepEqual(codexUpdate({
    id: 'shell', type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: 'passed', exit_code: 0,
  }), { id: 'shell', role: 'tool', text: 'completed: npm test\npassed' });
  assert.match(codexUpdate({ id: 'patch', type: 'file_change', status: 'completed', changes: [{ kind: 'add', path: 'src/main.ts' }] })!.text, /add: src\/main.ts/);
});

test('Cursor assistant content extracts text and tool updates use a stable call ID', () => {
  const base = { agent_id: 'agent-1', run_id: 'run-1' };
  assert.deepEqual(cursorUpdate({
    ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<script>literal</script>' }] },
  }, 0), { id: 'assistant-0', role: 'assistant', text: '<script>literal</script>' });
  const started = cursorUpdate({ ...base, type: 'tool_call', call_id: 'tool1', name: 'Read', status: 'running' }, 1);
  const completed = cursorUpdate({ ...base, type: 'tool_call', call_id: 'tool1', name: 'Read', status: 'completed', result: { ok: true } }, 2);
  assert.equal(started?.id, completed?.id);
  assert.match(completed?.text ?? '', /^completed: Read/);
  assert.match(completed?.text ?? '', /"ok": true/);
  assert.equal(cursorUpdate({ ...base, type: 'status', status: 'FINISHED', message: 'finished' }, 3), undefined);
  assert.equal(cursorUpdate({ ...base, type: 'task', text: '' }, 4), undefined);
  assert.equal(cursorUpdate({ ...base, type: 'unknown' } as never, 5), undefined);
});

test('Codex errors, unknown items, and cache-write deltas stay explicit', () => {
  assert.equal(codexUpdate({ id: 'bad', type: 'error', message: 'boom' })?.role, 'error');
  assert.equal(codexUpdate({ id: 'mystery', type: 'future_item' } as never), undefined);
  assert.match(codexUpdate({ id: 'mcp', type: 'mcp_tool_call', status: 'failed', server: 'docs', tool: 'search', arguments: {}, error: { message: 'denied' } })?.text ?? '', /denied/);
  assert.match(codexUpdate({ id: 'web', type: 'web_search', query: 'protocol' })?.text ?? '', /protocol/);
  assert.match(codexUpdate({ id: 'todos', type: 'todo_list', items: [{ text: 'write tests', completed: false }] })?.text ?? '', /write tests/);
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
