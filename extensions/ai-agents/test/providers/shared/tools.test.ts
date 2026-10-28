import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTool, codexTool, describedTool, toolStatus } from '../../../src/providers/tools.js';

test('tool metadata keeps the command, failure, and edited path', () => {
  assert.equal(classifyTool('git', 'status'), 'git');
  assert.equal(toolStatus(undefined), 'completed');
  assert.equal(toolStatus('completed', 1), 'error');
  assert.deepEqual(codexTool({
    id: 'shell', type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: 'no', exit_code: 1,
  }), { kind: 'shell', name: 'command', status: 'error', target: 'npm test', exitCode: 1 });
  assert.equal(codexTool({
    id: 'git', type: 'command_execution', command: 'git status', status: 'in_progress', aggregated_output: '',
  })?.kind, 'git');
  assert.equal(codexTool({ id: 'plain', type: 'command_execution', command: 'ls', status: 'completed', aggregated_output: '' })?.exitCode, undefined);
  assert.equal(codexTool({ id: 'files', type: 'file_change', status: 'completed', changes: [{ kind: 'update', path: 'a.ts' }, { kind: 'update', path: '' }] })?.target, 'a.ts');
  assert.equal(codexTool({ id: 'none', type: 'file_change', status: 'completed', changes: [] })?.target, undefined);
  assert.equal(codexTool({ id: 'mcp', type: 'mcp_tool_call', status: 'completed', server: 'docs', tool: 'search', arguments: {} })?.status, 'completed');
  assert.equal(codexTool({ id: 'web', type: 'web_search', query: 'protocol' })?.target, 'protocol');
  assert.equal(codexTool({ id: 'msg', type: 'agent_message', text: 'hi' }), undefined);
});

test('described tool preserves read spans', () => {
  assert.deepEqual(describedTool('Read', 'README.md L1-4\nextra', 'completed'), {
    kind: 'read', name: 'Read', status: 'completed', target: 'README.md', line: 1, endLine: 4,
  });
});
