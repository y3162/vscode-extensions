
import assert from 'node:assert/strict';

import { mock, test } from 'node:test';

import { codexTool } from '../../src/providers/tools.js';

test('Codex MCP failures retain failed status in tool metadata', () => {
  assert.deepEqual(codexTool({
    id: 'mcp-error', type: 'mcp_tool_call', status: 'completed', server: 'docs', tool: 'search',
    arguments: {}, error: { message: 'permission denied' },
  }), { kind: 'mcp', name: 'docs/search', status: 'error', target: 'search' });
});;
