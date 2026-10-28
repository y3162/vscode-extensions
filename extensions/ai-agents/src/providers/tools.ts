import type { ThreadItem } from './codex-items.js';
import type { ToolInfo } from '../types.js';
import { classifyTool, toolStatus } from '../tool-kind.js';
import { readLocation } from './read-location.js';

export { classifyTool, toolStatus };

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

export function describedTool(type: string, text: string, status?: string): ToolInfo {
  const kind = classifyTool(type, text);
  const target = text.split('\n')[0]?.slice(0, 240);
  const location = kind === 'read' ? readLocation(type, target) : {};
  return {
    kind, name: type || kind, status: toolStatus(status),
    ...(location.path ? { target: location.path } : target ? { target } : {}),
    ...(location.line ? { line: location.line } : {}),
    ...(location.endLine ? { endLine: location.endLine } : {}),
  };
}
