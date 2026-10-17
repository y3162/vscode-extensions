import type { ThreadItem } from '@openai/codex-sdk';
import type { SDKMessage } from '@cursor/sdk';
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

export function cursorUpdate(event: SDKMessage, index: number): AgentUpdate | undefined {
  switch (event.type) {
    case 'assistant': return {
      id: `assistant-${index}`, role: 'assistant',
      text: event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    };
    case 'tool_call': return { id: `tool-${event.call_id}`, role: 'tool', text: event.result === undefined ? `${event.status}: ${event.name}` : `${event.status}: ${event.name}\n${JSON.stringify(event.result, null, 2)}` };
    case 'task': return event.text ? { id: `task-${index}`, role: 'status', text: event.text } : undefined;
    case 'status': if (/^(finished|running|completed|started)$/i.test(event.message ?? event.status)) return undefined; return { id: 'status', role: 'status', text: event.message ?? event.status };
    default: return undefined;
  }
}
