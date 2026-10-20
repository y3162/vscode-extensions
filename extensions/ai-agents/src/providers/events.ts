import type { ThreadItem } from '@openai/codex-sdk';
import type { SDKMessage } from '@cursor/sdk';
import type { AgentUpdate } from '../types.js';

function terminalResult(result: unknown): string | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const outer = record(result);
  if (!outer) return undefined;
  const success = record(outer.success);
  const output = [outer, record(outer.value), success, record(success?.value)].find((value) =>
    typeof value?.stdout === 'string' || typeof value?.stderr === 'string');
  if (!output) return undefined;

  const stdout = typeof output.stdout === 'string' ? output.stdout : '';
  const stderr = typeof output.stderr === 'string' ? output.stderr : '';
  const body = `${stdout}${stdout && stderr && !stdout.endsWith('\n') ? '\n' : ''}${stderr}`;
  const exitCode = typeof output.exitCode === 'number' ? output.exitCode
    : typeof output.exit_code === 'number' ? output.exit_code : undefined;
  return exitCode === undefined ? body : `${body}${body && !body.endsWith('\n') ? '\n' : ''}Exit code: ${exitCode}`;
}

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
    case 'tool_call': return { id: `tool-${event.call_id}`, role: 'tool', text: event.result === undefined ? `${event.status}: ${event.name}` : `${event.status}: ${event.name}\n${terminalResult(event.result) ?? JSON.stringify(event.result, null, 2)}` };
    case 'task': return event.text ? { id: `task-${index}`, role: 'status', text: event.text } : undefined;
    case 'status': if (/^(finished|running|completed|started)$/i.test(event.message ?? event.status)) return undefined; return { id: 'status', role: 'status', text: event.message ?? event.status };
    default: return undefined;
  }
}
