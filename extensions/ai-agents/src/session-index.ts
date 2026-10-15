import type { SessionSummary } from './types.js';

export function upsertSession(list: SessionSummary[], item: SessionSummary): SessionSummary[] {
  const next = list.filter((session) => !(session.provider === item.provider && session.id === item.id));
  next.unshift(item);
  return next.slice(0, 50);
}

export function sessionTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return (line || 'New chat').slice(0, 80);
}
