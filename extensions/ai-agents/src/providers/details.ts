import type { SDKMessage } from '@cursor/sdk';
import type { ThreadItem } from '@openai/codex-sdk';
import { normalizeChangeKind } from '../diff-stats.js';
import type { FileChange, TodoEntry, UpdateMeta, UsageStats } from '../types.js';

export function addUsage(current: UsageStats | null, next: UsageStats): UsageStats {
  const sum = (left?: number, right?: number) => (left ?? 0) + (right ?? 0);
  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    cachedInputTokens: sum(current?.cachedInputTokens, next.cachedInputTokens),
    cacheWriteInputTokens: sum(current?.cacheWriteInputTokens, next.cacheWriteInputTokens),
    reasoningTokens: sum(current?.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens) || undefined,
  };
}

export function codexUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): UsageStats {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function filePathOf(value: unknown): string | undefined {
  const record = asRecord(value);
  const path = record?.path ?? record?.file_path ?? record?.filePath;
  return typeof path === 'string' && path ? path : undefined;
}

export function codexMeta(item: ThreadItem): UpdateMeta | undefined {
  if (item.type === 'file_change') {
    const files: FileChange[] = item.changes.map((change) => {
      const extra = change as { diff?: unknown; previousText?: unknown; kind: unknown };
      const normalized = normalizeChangeKind(extra.kind);
      return {
        path: normalized.movePath ?? change.path,
        kind: normalized.kind,
        ...(normalized.movePath ? { oldPath: change.path } : normalized.oldPath ? { oldPath: normalized.oldPath } : {}),
        ...(typeof extra.diff === 'string' ? { diff: extra.diff } : {}),
        ...(typeof extra.previousText === 'string' || extra.previousText === null ? { previousText: extra.previousText } : {}),
      };
    });
    return files.length ? { type: 'files', files } : undefined;
  }
  if (item.type === 'todo_list') {
    const todos: TodoEntry[] = item.items.map((todo) => ({ content: todo.text, status: todo.completed ? 'completed' : 'pending' }));
    return { type: 'todo', todos };
  }
  return undefined;
}

const fileMutations = new Set(['edit', 'write', 'delete', 'applyagentdiff']);

function toolSuccess(result: unknown): Record<string, unknown> | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  if (record.status === 'success') return asRecord(record.value);
  const success = asRecord(record.success);
  if (success?.status === 'success') return asRecord(success.value);
  return asRecord(record.value) ?? (success ? asRecord(success.value) : undefined);
}

export function cursorMeta(event: SDKMessage): UpdateMeta | undefined {
  if (event.type === 'thinking' && event.text) return { type: 'thinking', append: true };
  if (event.type === 'usage') {
    return {
      type: 'usage',
      usage: {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cachedInputTokens: event.usage.cacheReadTokens,
        cacheWriteInputTokens: event.usage.cacheWriteTokens,
        reasoningTokens: event.usage.reasoningTokens,
        totalTokens: event.usage.totalTokens,
      },
    };
  }
  if (event.type === 'task' && event.text) return { type: 'task', task: event.text };
  if (event.type !== 'tool_call') return undefined;
  const name = event.name.toLowerCase();
  const args = asRecord(event.args);
  const result = asRecord(event.result);
  const value = toolSuccess(event.result);
  if (name === 'updatetodos' || name === 'update_todos') {
    const raw = Array.isArray(args?.todos) ? args.todos : Array.isArray(value?.todos) ? value.todos : Array.isArray(result?.todos) ? result.todos : [];
    const todos = raw.flatMap((item) => {
      const todo = asRecord(item);
      const content = typeof todo?.content === 'string' ? todo.content : typeof todo?.text === 'string' ? todo.text : '';
      if (!content) return [];
      const status = typeof todo?.status === 'string' ? todo.status : 'pending';
      return [{ content, status }];
    });
    return todos.length ? { type: 'todo', todos } : undefined;
  }
  if (name === 'createplan') {
    const plan = typeof args?.plan === 'string' ? args.plan : typeof value?.plan === 'string' ? value.plan : '';
    return plan.trim() ? { type: 'plan', plan: { markdown: plan, source: 'sdk-createPlan' } } : undefined;
  }
  if (name === 'task') {
    const description = typeof args?.description === 'string' ? args.description : event.name;
    const subagentType = asRecord(args?.subagentType);
    const typeName = typeof subagentType?.name === 'string' ? subagentType.name : typeof subagentType?.kind === 'string' ? subagentType.kind : description;
    const background = typeof value?.isBackground === 'boolean' ? value.isBackground : 'unknown' as const;
    return {
      type: 'subagent',
      subagent: {
        id: event.call_id,
        name: typeName,
        ...(typeof args?.prompt === 'string' ? { task: args.prompt } : { task: description }),
        status: event.status === 'running' ? 'running' : event.status === 'error' ? 'error' : 'completed',
        background,
        ...(typeof value?.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
        ...(typeof value?.resultSuffix === 'string' ? { resultPreview: value.resultSuffix.slice(0, 500) } : {}),
      },
    };
  }
  const imagePath = name === 'generateimage' ? filePathOf(value) ?? filePathOf(result) ?? filePathOf(args) : undefined;
  if (imagePath) return { type: 'image', imagePath };
  if (!fileMutations.has(name)) return undefined;
  const filePath = filePathOf(args) ?? filePathOf(value) ?? filePathOf(result);
  const diff = typeof value?.diffString === 'string' ? value.diffString
    : typeof result?.diffString === 'string' ? result.diffString : undefined;
  const additions = typeof value?.linesAdded === 'number' ? value.linesAdded
    : typeof value?.linesCreated === 'number' ? value.linesCreated : undefined;
  const deletions = typeof value?.linesRemoved === 'number' ? value.linesRemoved : undefined;
  if (!filePath && !diff) return undefined;
  return {
    type: 'files',
    files: [{
      path: filePath ?? 'patch',
      kind: name === 'delete' ? 'delete' : name === 'write' ? 'add' : 'update',
      ...(diff ? { diff } : {}),
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
    }],
  };
}

export function lightMeta(meta: UpdateMeta | undefined): UpdateMeta | undefined {
  if (!meta) return undefined;
  if (meta.type !== 'files' || !meta.files) return meta;
  return {
    ...meta,
    files: meta.files.map(({ previousText: _previous, diff: _diff, ...file }) => file),
  };
}
