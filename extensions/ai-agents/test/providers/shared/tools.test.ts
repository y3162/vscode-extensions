import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@cursor/sdk';
import { classifyTool, codexTool, cursorTool, describedTool, toolStatus } from '../../../src/providers/tools.js';

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
  assert.equal(cursorTool({
    type: 'tool_call', agent_id: 'a', run_id: 'r', call_id: 'c', name: 'Read', status: 'running', args: { path: 'src/main.ts' },
  })?.target, 'src/main.ts');
  assert.equal(codexTool({ id: 'plain', type: 'command_execution', command: 'ls', status: 'completed', aggregated_output: '' })?.exitCode, undefined);
  assert.equal(codexTool({ id: 'files', type: 'file_change', status: 'completed', changes: [{ kind: 'update', path: 'a.ts' }, { kind: 'update', path: '' }] })?.target, 'a.ts');
  assert.equal(codexTool({ id: 'none', type: 'file_change', status: 'completed', changes: [] })?.target, undefined);
  assert.equal(codexTool({ id: 'mcp', type: 'mcp_tool_call', status: 'completed', server: 'docs', tool: 'search', arguments: {} })?.status, 'completed');
  assert.equal(codexTool({ id: 'web', type: 'web_search', query: 'protocol' })?.target, 'protocol');
  assert.equal(codexTool({ id: 'msg', type: 'agent_message', text: 'hi' }), undefined);
});

test('Cursor tool targets walk argument fields and read spans stay on the tool', () => {
  const call = (name: string, args: unknown, status: 'running' | 'completed' | 'error' = 'completed'): SDKMessage => ({
    type: 'tool_call', agent_id: 'a', run_id: 'r', call_id: 'c', name, status, args,
  });
  assert.equal(cursorTool({ type: 'assistant', agent_id: 'a', run_id: 'r', message: { role: 'assistant', content: [] } }), undefined);
  assert.equal(cursorTool(call('Shell', { command: '  ', path: 'a.ts' }))?.target, 'a.ts');
  assert.equal(cursorTool(call('rg', { file_path: 'b.ts' }))?.target, 'b.ts');
  assert.equal(cursorTool(call('grep', { query: 'q' }))?.kind, 'search');
  assert.equal(cursorTool(call('glob', { pattern: '**/*.ts' }))?.target, '**/*.ts');
  assert.equal(cursorTool(call('find', { glob_pattern: '*.md' }))?.target, '*.md');
  const read = cursorTool(call('Read', { path: 'src/a.ts', line: 2, endLine: 5 }, 'running'));
  assert.deepEqual(read, { kind: 'read', name: 'Read', status: 'running', target: 'src/a.ts', line: 2, endLine: 5 });
  assert.equal(cursorTool(call('Other', {}))?.target, undefined);
  assert.equal(cursorTool(call('Shell', 'not-object'))?.target, undefined);
  assert.deepEqual(describedTool('Read', 'README.md L1-4\nextra', 'completed'), {
    kind: 'read', name: 'Read', status: 'completed', target: 'README.md', line: 1, endLine: 4,
  });
  assert.equal(describedTool('', 'git status')?.name, 'git');
  assert.equal(describedTool('shell', '', undefined)?.target, undefined);
  assert.equal(describedTool('shell', '', undefined)?.status, 'completed');
});
