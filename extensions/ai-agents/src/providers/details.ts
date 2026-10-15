import type { SDKMessage } from '@cursor/sdk';
import type { ThreadItem } from '@openai/codex-sdk';
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
      const extra = change as { diff?: unknown; previousText?: unknown };
      return {
        path: change.path,
        kind: change.kind === 'add' || change.kind === 'delete' ? change.kind : 'update',
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
  const args = asRecord(event.args);
  const result = asRecord(event.result);
  if (event.name === 'updateTodos' || event.name === 'update_todos') {
    const raw = Array.isArray(args?.todos) ? args.todos : Array.isArray(result?.todos) ? result.todos : [];
    const todos = raw.flatMap((item) => {
      const todo = asRecord(item);
      const content = typeof todo?.content === 'string' ? todo.content : typeof todo?.text === 'string' ? todo.text : '';
      if (!content) return [];
      const status = typeof todo?.status === 'string' ? todo.status : 'pending';
      return [{ content, status }];
    });
    return todos.length ? { type: 'todo', todos } : undefined;
  }
  const path = filePathOf(args) ?? filePathOf(result);
  const diff = typeof result?.diffString === 'string' ? result.diffString
    : typeof asRecord(result?.success)?.diffString === 'string' ? String(asRecord(result?.success)?.diffString) : undefined;
  const fileResult = asRecord(result?.value) ?? asRecord(asRecord(result?.success)?.value);
  const imagePath = event.name === 'generateImage' ? filePathOf(fileResult) ?? filePathOf(result) ?? path : undefined;
  if (imagePath) return { type: 'image', imagePath };
  if (event.name === 'task') {
    const description = typeof args?.description === 'string' ? args.description : event.name;
    return { type: 'task', task: description };
  }
  if (!path && !diff) return undefined;
  const additions = typeof result?.linesAdded === 'number' ? result.linesAdded : undefined;
  const deletions = typeof result?.linesRemoved === 'number' ? result.linesRemoved : undefined;
  return {
    type: 'files',
    files: [{
      path: path ?? 'patch',
      kind: event.name === 'delete' ? 'delete' : 'update',
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
