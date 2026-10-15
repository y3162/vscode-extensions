import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexUpdate, cursorUpdate } from '../src/providers/events.js';

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
  const completed = cursorUpdate({ ...base, type: 'tool_call', call_id: 'tool1', name: 'Read', status: 'completed' }, 2);
  assert.equal(started?.id, completed?.id);
  assert.equal(completed?.text, 'completed: Read');
});
