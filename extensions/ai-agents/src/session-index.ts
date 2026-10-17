import type { SessionSummary } from './types.js';

export function mergeRegistrySessions(current: SessionSummary[], live: SessionSummary[]): SessionSummary[] {
  let sessions = [...current];
  for (const item of live) {
    const existing = sessions.find((session) => session.provider === item.provider && session.id === item.id && (!session.backend || !item.backend || session.backend === item.backend));
    const title = existing?.title && (item.title === item.id || !item.title) ? existing.title : item.title || existing?.title || item.id;
    sessions = upsertSession(sessions, {
      ...existing,
      ...item,
      title,
      ...(item.activity ?? existing?.activity ? { activity: item.activity ?? existing?.activity } : {}),
    });
  }
  return sessions;
}

export function upsertSession(list: SessionSummary[], item: SessionSummary): SessionSummary[] {
  const next = list.filter((session) => !(session.provider === item.provider && session.id === item.id && (!session.backend || !item.backend || session.backend === item.backend)));
  const previous = list.find((session) => session.provider === item.provider && session.id === item.id && (!session.backend || !item.backend || session.backend === item.backend));
  next.unshift({ ...previous, ...item });
  return next;
}

export function sessionTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return (line || 'New chat').slice(0, 80);
}
