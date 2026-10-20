import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUpdate, cursorUpdate } from '../../../src/providers/events.js';
import { usageDifference } from '../../../src/usage.js';

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
  assert.equal(cursorUpdate({ ...base, type: 'status', status: 'RUNNING' }, 6), undefined);
  assert.equal(cursorUpdate({ ...base, type: 'status', status: 'ERROR', message: 'needs input' }, 7)?.text, 'needs input');
  assert.equal(cursorUpdate({ ...base, type: 'status', status: 'ERROR' }, 8)?.text, 'ERROR');
  assert.equal(cursorUpdate({ ...base, type: 'task', text: 'follow up' }, 9)?.text, 'follow up');
  assert.equal(cursorUpdate({ ...base, type: 'task', text: '' }, 4), undefined);
  assert.equal(cursorUpdate({
    ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }, { type: 'text', text: 'after' }] },
  }, 10)?.text, 'after');
  assert.equal(cursorUpdate({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, 11), undefined);
});

test('Cursor terminal results show output and exit code while other results keep JSON', () => {
  const base = { agent_id: 'agent-1', run_id: 'run-1', type: 'tool_call', call_id: 'shell', name: 'Shell', status: 'completed' } as const;
  assert.equal(cursorUpdate({ ...base, result: { stdout: 'hello\n', stderr: 'warning\n', exitCode: 2 } }, 0)?.text,
    'completed: Shell\nhello\nwarning\nExit code: 2');
  assert.equal(cursorUpdate({ ...base, result: { status: 'success', value: { stdout: 'done', stderr: '', exitCode: 0 } } }, 0)?.text,
    'completed: Shell\ndone\nExit code: 0');
  assert.equal(cursorUpdate({ ...base, result: { success: { value: { stdout: '', stderr: 'failed', exit_code: 1 } } } }, 0)?.text,
    'completed: Shell\nfailed\nExit code: 1');
  assert.equal(cursorUpdate({ ...base, result: { stdout: '', stderr: '' } }, 0)?.text, 'completed: Shell\n');
  assert.equal(cursorUpdate({ ...base, result: { stdout: 'first', stderr: 'second' } }, 0)?.text,
    'completed: Shell\nfirst\nsecond');
  assert.equal(cursorUpdate({ ...base, result: { stdout: 'only stdout' } }, 0)?.text,
    'completed: Shell\nonly stdout');
  assert.equal(cursorUpdate({ ...base, result: { stderr: 'only stderr' } }, 0)?.text,
    'completed: Shell\nonly stderr');
  assert.equal(cursorUpdate({ ...base, result: null }, 0)?.text, 'completed: Shell\nnull');
  assert.match(cursorUpdate({ ...base, name: 'Read', result: { ok: true } }, 0)?.text ?? '', /"ok": true/);
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
