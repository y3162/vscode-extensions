import type { AgentUpdate, SessionSummary } from '../types.js';

export interface ManagedRun {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  updates: AgentUpdate[];
  error?: string;
}
export interface ManagedSnapshot {
  identity?: SessionSummary;
  backendTurnId?: string;
  rewindUnsupportedReason?: string;
  run?: ManagedRun;
  pid: number;
  sessionClosed?: boolean;
}
export interface ManagedMessage {
  id?: number;
  method?: string;
  args?: unknown;
  token?: string;
  value?: unknown;
  error?: string;
  sessionClosed?: boolean;
  settled?: boolean;
  update?: AgentUpdate;
  background?: AgentUpdate;
  interaction?: { id: number; method: string; args: unknown };
  identity?: SessionSummary;
}
