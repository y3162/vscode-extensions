import type { AgentInteractions, AgentMode, Backend, Selection, SessionSummary } from '../types.js';

export interface SessionOptions extends Selection {
  storagePath: string;
  apiKey?: string;
  codexPath?: string;
  agentPath?: string;
  backend?: Backend;
  mode?: AgentMode;
  sandbox?: string;
  approval?: string;
  network?: boolean;
  webSearch?: string;
  additionalDirectories?: string[];
  resumeId?: string;
  signal?: AbortSignal;
  interactions?: AgentInteractions;
  onIdentity?: (summary: SessionSummary) => void;
}
