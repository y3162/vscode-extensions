import type { SessionSummary } from './types.js';

export function genericSessionTitle(title: string, id: string): boolean {
  return !title.trim() || title === id || /^new agent$/i.test(title.trim());
}

export function mergeRegistrySessions(current: SessionSummary[], live: SessionSummary[]): SessionSummary[] {
  let sessions = [...current];
  for (const item of live) {
    sessions = upsertSession(sessions, { ...item, title: item.title || item.id });
  }
  return sessions;
}

export function upsertSession(list: SessionSummary[], item: SessionSummary): SessionSummary[] {
  const next = list.filter((session) => !(session.provider === item.provider && session.id === item.id && (!session.backend || !item.backend || session.backend === item.backend)));
  const previous = list.find((session) => session.provider === item.provider && session.id === item.id && (!session.backend || !item.backend || session.backend === item.backend));
  const incomingTitle = genericSessionTitle(item.title, item.id) ? '' : item.title;
  const previousTitle = previous && !genericSessionTitle(previous.title, previous.id) ? previous.title : '';
  const keepPrevious = previousTitle && (!incomingTitle || item.titleSource !== 'provider' && (previous?.titleSource === 'provider' || previous?.titleSource === undefined && item.titleSource === 'local'));
  next.unshift({
    ...previous, ...item,
    title: keepPrevious ? previousTitle : incomingTitle || (item.title ? item.id : item.title),
    titleSource: keepPrevious ? previous?.titleSource : incomingTitle ? item.titleSource : 'local',
    ...(item.activity ?? previous?.activity ? { activity: item.activity ?? previous?.activity } : {}),
  });
  return next;
}

export function sessionTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!;
  return (line || 'New chat').slice(0, 80);
}
