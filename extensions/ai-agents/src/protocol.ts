import type {
  Backend, ChatMessage, ConnectionStatus, PermissionRequest, PlanRequest, Provider, QuestionRequest, SessionSummary, ToolInfo, UsageStats,
} from './types.js';

export interface ViewChoice {
  id: string;
  label: string;
  description?: string;
}

export interface ViewFile {
  path: string;
  kind: string;
  additions?: number;
  deletions?: number;
}

export interface ViewMeta {
  type: NonNullable<ChatMessage['meta']>['type'];
  files?: ViewFile[];
  todos?: { content: string; status: string }[];
  task?: string;
  imagePath?: string;
}

export interface ViewMessage {
  id: string;
  role: ChatMessage['role'];
  text: string;
  at?: number;
  attachments?: string[];
  tool?: ToolInfo;
  meta?: ViewMeta;
}

export interface ViewChange {
  path: string;
  name: string;
  kind: string;
  additions?: number;
  deletions?: number;
  canRevert: boolean;
  canDiff: boolean;
  synthetic: boolean;
  patch?: string;
}

export interface ViewBanner {
  id: string;
  title: string;
  body: string;
}

export interface ViewShell {
  provider: Provider;
  providerLabel: string;
  cwd: string;
  busy: boolean;
  presence: 'idle' | 'running' | 'waiting' | 'error';
  statusText: string;
  sessionTitle: string;
  sessionId?: string;
  modelLabel: string;
  effortLabel: string | null;
  accessLabel: string;
  risky: boolean;
  banner: ViewBanner | null;
  backendLabel: string;
  folderName: string;
  folders: { name: string; path: string }[];
  modes: ViewChoice[];
  mode: string;
  showMode: boolean;
  sandboxChoices: ViewChoice[];
  sandbox: string;
  approvalChoices: ViewChoice[];
  approval: string;
  showApproval: boolean;
  webSearchChoices: ViewChoice[];
  webSearch: string;
  showWebSearch: boolean;
  network: boolean;
  showNetwork: boolean;
  backendChoices: ViewChoice[];
  backend: Backend;
  additionalDirectories: string[];
  autoApprove: boolean;
  steer: boolean;
  interactiveApproval: boolean;
  queue: { id: string; text: string; images: number }[];
  changes: ViewChange[];
  additions: number;
  deletions: number;
  sessions: SessionSummary[];
  usage: UsageStats | null;
  permission: { token: string; request: PermissionRequest } | null;
  plan: { token: string; request: PlanRequest } | null;
  question: { token: string; request: QuestionRequest } | null;
  activeFile: { label: string; token: string } | null;
  locale: 'ja' | 'en';
  providers: { id: Provider; label: string; detail: string }[];
}

export interface MessageDiff {
  removed: string[];
  upserts: ViewMessage[];
  order: string[];
}

export interface StateMessage {
  type: 'state';
  revision: number;
  full: boolean;
  shell: ViewShell;
  messages: MessageDiff;
}

export interface SuggestionItem {
  label: string;
  description?: string;
  token: string;
}

export interface ProbeResult {
  turns: number;
  pending: boolean;
  history: boolean;
  settings: boolean;
}

export type HostToWebview =
  | StateMessage
  | { type: 'error'; text: string }
  | { type: 'suggestions'; requestId: number; items: SuggestionItem[] }
  | { type: 'inspector'; title: string; text: string }
  | { type: 'insert'; text: string; label?: string }
  | { type: 'navigate'; panel: 'history' | 'settings' | 'chat' }
  | { type: 'probe' };

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export type { ConnectionStatus };
