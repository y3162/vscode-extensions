import type { ToolInfo } from './types.js';

export function classifyTool(name: string, target = ''): ToolInfo['kind'] {
  const text = `${name} ${target}`.toLowerCase();
  if (/\bgit\b/.test(text)) return 'git';
  if (/\b(shell|command|exec|terminal|bash|powershell)\b/.test(text)) return 'shell';
  if (/\b(search|grep|glob|find|web)\b/.test(text)) return 'search';
  if (/\b(read|open|list)\b/.test(text)) return 'read';
  if (/\b(edit|write|patch|delete|create|replace)\b/.test(text)) return 'edit';
  if (text.includes('mcp')) return 'mcp';
  if (/\b(task|subagent)\b/.test(text)) return 'subagent';
  return 'other';
}

export function toolStatus(status: string | undefined, exitCode?: number): ToolInfo['status'] {
  if (typeof exitCode === 'number' && exitCode !== 0) return 'error';
  const value = (status ?? '').toLowerCase();
  if (value.includes('fail') || value === 'error' || value === 'incomplete' || value === 'cancelled') return 'error';
  if (value.includes('progress') || value === 'running' || value === 'pending' || value === 'in_progress') return 'running';
  return 'completed';
}
