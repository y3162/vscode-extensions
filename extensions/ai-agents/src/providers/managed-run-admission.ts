import type { ManagedRun } from './managed-protocol.js';

/** Accept an execution identity only once for the lifetime of its owner. */
export function acceptManagedRun(id: string, run: ManagedRun | undefined, accepted: Set<string>, limit = 10000): boolean {
  if (run?.id === id) return false;
  if (run?.status === 'running') throw new Error('The original execution is still running.');
  if (accepted.has(id)) throw new Error('This execution was already accepted; it cannot be dispatched again.');
  if (accepted.size >= limit) throw new Error('Execution owner reached its run limit. Close this session before starting another.');
  accepted.add(id);
  return true;
}
