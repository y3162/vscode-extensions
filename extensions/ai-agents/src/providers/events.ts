import type { ThreadItem } from './codex-items.js';
import type { AgentUpdate } from '../types.js';

export function codexUpdate(item: ThreadItem): AgentUpdate | undefined {
  const base = { id: item.id };
  switch (item.type) {
    case 'agent_message': return { ...base, role: 'assistant', text: item.text };
    case 'command_execution': return {
      ...base, role: 'tool',
      text: `${item.status}: ${item.command}\n${item.aggregated_output}`,
    };
    case 'file_change': return {
      ...base, role: 'tool',
      text: `${item.status}\n${item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n')}`,
    };
    case 'mcp_tool_call': return {
      ...base, role: 'tool', text: `${item.status}: ${item.server}/${item.tool}${item.error ? `\n${item.error.message}` : ''}`,
    };
    case 'web_search': return { ...base, role: 'tool', text: `Search: ${item.query}` };
    case 'todo_list': return {
      ...base, role: 'status', text: item.items.map((todo) => `${todo.completed ? '✓' : '○'} ${todo.text}`).join('\n'),
    };
    case 'error': return { ...base, role: 'error', text: item.message };
    default: return undefined;
  }
}
