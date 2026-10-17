import type { UsageStats } from './types.js';
const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'totalTokens'] as const;
export function usageDifference(next: UsageStats, previous: UsageStats): UsageStats | undefined {
  if (fields.some((key) => next[key] !== undefined && previous[key] !== undefined && next[key]! < previous[key]!)) return undefined;
  const result = { ...next, scope: 'turn' as const };
  for (const key of fields) {
    if (next[key] !== undefined && previous[key] !== undefined) result[key] = next[key]! - previous[key]!;
    else if (key !== 'inputTokens' && key !== 'outputTokens') delete result[key];
  }
  return result;
}
export function usageText(usage: UsageStats | null | undefined, unavailable = '未取得 / Not reported'): string {
  if (!usage) return unavailable;
  const n = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('en-US');
  return `Input ${n(usage.inputTokens)} · Output ${n(usage.outputTokens)} · Total ${n(usage.totalTokens)}`;
}
