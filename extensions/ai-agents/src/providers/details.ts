import type { ThreadItem } from './codex-items.js';
import { normalizeChangeKind, previewUnifiedDiff } from '../diff-stats.js';
import { redactSecrets, type FileChange, type TodoEntry, type UpdateMeta, type UsageStats } from '../types.js';

export function addUsage(current: UsageStats | null, next: UsageStats): UsageStats {
  const result: UsageStats = { ...next, inputTokens: (current?.inputTokens ?? 0) + next.inputTokens, outputTokens: (current?.outputTokens ?? 0) + next.outputTokens };
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'totalTokens'] as const) {
    if (next[key] !== undefined && (!current || current[key] !== undefined)) result[key] = (current?.[key] ?? 0) + next[key]!;
    else delete result[key];
  }
  return result;
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

export function lightMeta(meta: UpdateMeta | undefined): UpdateMeta | undefined {
  if (!meta) return undefined;
  if (meta.type === 'subagent' && meta.subagent) {
    const task = meta.subagent.task ? redactSecrets(meta.subagent.task) : undefined;
    const resultPreview = meta.subagent.resultPreview ? redactSecrets(meta.subagent.resultPreview).slice(0, 500) : undefined;
    const progress = meta.subagent.progress ? redactSecrets(meta.subagent.progress).slice(0, 180) : undefined;
    const error = meta.subagent.error ? redactSecrets(meta.subagent.error).slice(0, 4000) : undefined;
    return {
      ...meta,
      subagent: {
        ...meta.subagent,
        ...(task ? { task: task.slice(0, 12000), ...(task.length > 12000 ? { taskOmitted: true } : {}) } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(progress ? { progress } : {}),
        ...(error ? { error } : {}),
      },
    };
  }
  if (meta.type !== 'files' || !meta.files) return meta;
  return {
    ...meta,
    files: meta.files.map(({ previousText: _previous, diff, ...file }) => ({
      ...file,
      ...(file.preview?.length ? {} : diff ? { preview: previewUnifiedDiff(diff) } : {}),
    })),
  };
}
