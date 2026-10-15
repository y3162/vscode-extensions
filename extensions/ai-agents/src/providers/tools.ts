import type { SDKMessage } from '@cursor/sdk';
import type { ThreadItem } from '@openai/codex-sdk';
import type { ToolInfo } from '../types.js';
import { classifyTool, toolStatus } from '../tool-kind.js';

export { classifyTool, toolStatus };

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function codexTool(item: ThreadItem): ToolInfo | undefined {
  switch (item.type) {
    case 'command_execution': {
      const kind = classifyTool(item.command.trim().startsWith('git ') ? 'git' : 'shell', item.command);
      return {
        kind, name: kind === 'git' ? 'git' : 'command', status: toolStatus(item.status, item.exit_code),
        target: item.command, ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
      };
    }
    case 'file_change': {
      const target = item.changes.map((change) => change.path).filter(Boolean).join(', ');
      return { kind: 'edit', name: 'edit', status: toolStatus(item.status), ...(target ? { target } : {}) };
    }
    case 'mcp_tool_call':
      return { kind: 'mcp', name: `${item.server}/${item.tool}`, status: toolStatus(item.status, item.error ? 1 : undefined), target: item.tool };
    case 'web_search':
      return { kind: 'search', name: 'search', status: 'completed', target: item.query };
    default:
      return undefined;
  }
}

export function cursorTool(event: SDKMessage): ToolInfo | undefined {
  if (event.type !== 'tool_call') return undefined;
  const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {};
  const target = textField(args.command) ?? textField(args.path) ?? textField(args.file_path) ?? textField(args.query)
    ?? textField(args.pattern) ?? textField(args.glob_pattern);
  return {
    kind: classifyTool(event.name, target),
    name: event.name,
    status: toolStatus(event.status),
    ...(target ? { target } : {}),
  };
}

export function describedTool(type: string, text: string, status?: string): ToolInfo {
  const kind = classifyTool(type, text);
  const target = text.split('\n')[0]?.slice(0, 240);
  return { kind, name: type || kind, status: toolStatus(status), ...(target ? { target } : {}) };
}
