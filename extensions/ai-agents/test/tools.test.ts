import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexTool, cursorTool } from '../src/providers/tools.js';

test('tool metadata keeps the command, failure, and edited path', () => {
  assert.deepEqual(codexTool({
    id: 'shell', type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: 'no', exit_code: 1,
  }), { kind: 'shell', name: 'command', status: 'error', target: 'npm test', exitCode: 1 });
  assert.equal(codexTool({
    id: 'git', type: 'command_execution', command: 'git status', status: 'in_progress', aggregated_output: '',
  })?.kind, 'git');
  assert.equal(cursorTool({
    type: 'tool_call', agent_id: 'a', run_id: 'r', call_id: 'c', name: 'Read', status: 'running', args: { path: 'src/main.ts' },
  })?.target, 'src/main.ts');
});
