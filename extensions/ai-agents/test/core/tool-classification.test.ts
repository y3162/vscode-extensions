import assert from 'node:assert/strict';

import { test } from 'node:test';

import { classifyTool, toolStatus } from '../../src/tool-kind.js';

test('tool classification and status cover task, subagent, and exit boundaries', () => {
  assert.equal(classifyTool('Git'), 'git');
  assert.equal(classifyTool('run', 'powershell'), 'shell');
  assert.equal(classifyTool('search', 'files'), 'search');
  assert.equal(classifyTool('Read', 'file.ts'), 'read');
  assert.equal(classifyTool('patch', 'file.ts'), 'edit');
  assert.equal(classifyTool('mcp_server'), 'mcp');
  assert.equal(classifyTool('Task'), 'subagent');
  assert.equal(classifyTool('launch', 'subagent'), 'subagent');
  assert.equal(classifyTool('custom'), 'other');
  assert.equal(toolStatus('completed', 0), 'completed');
  assert.equal(toolStatus('completed', 1), 'error');
  assert.equal(toolStatus('FAILED'), 'error');
  assert.equal(toolStatus('incomplete'), 'error');
  assert.equal(toolStatus('cancelled'), 'error');
  assert.equal(toolStatus('in_progress'), 'running');
  assert.equal(toolStatus('pending'), 'running');
  assert.equal(toolStatus(undefined), 'completed');
});;
