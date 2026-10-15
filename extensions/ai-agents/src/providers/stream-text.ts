// Joins provider chunks whether each event is a delta or a full snapshot.
export function mergeStreamText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous || incoming === previous || incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming) || previous.endsWith(incoming)) return previous;
  return previous + incoming;
}
