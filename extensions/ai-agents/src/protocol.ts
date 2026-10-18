import type {
  Backend, ChatMessage, ConnectionStatus, ImageAttachment, PermissionRequest, PlanPhase, PlanRequest, PlanSource, Provider, QuestionRequest,
  FileDiffLine, SessionSummary, SubagentBackground, ToolInfo, TurnRecord, UsageStats,
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
  preview?: FileDiffLine[];
  icon?: ViewFileIcon;
}

export interface ViewMeta {
  type: NonNullable<ChatMessage['meta']>['type'];
  files?: ViewFile[];
  todos?: { content: string; status: string }[];
  task?: string;
  imagePath?: string;
  subagent?: ViewSubagent;
}

export interface ViewMessage {
  id: string;
  role: ChatMessage['role'];
  text: string;
  at?: number;
  attachments?: string[];
  tool?: ToolInfo;
  meta?: ViewMeta;
  final?: boolean;
  turnId?: string;
  subagentId?: string;
  failure?: ChatMessage['failure'];
  canRewind?: boolean;
  rewindReason?: string;
}

export interface ViewFileIcon {
  type: 'image' | 'font' | 'badge';
  src?: string;
  badge?: string;
  fontFamily?: string;
  fontCharacter?: string;
  fontColor?: string;
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
  icon?: ViewFileIcon;
}

export interface ViewPlan {
  id: string;
  revision: number;
  phase: PlanPhase;
  name?: string;
  overview?: string;
  markdown: string;
  todos: { content: string; status: string }[];
  files?: string[];
  restored?: boolean;
  source: PlanSource;
  buildModelId: string;
  buildModelLabel: string;
  buildParams: { id: string; value: string }[];
  showBuildModel: boolean;
  canBuild: boolean;
  error?: string;
  history: { revision: number; name?: string; markdown: string }[];
}

export interface ViewTurnTiming {
  id: string;
  startedAt: number;
  endedAt?: number;
  waitMs: number;
  status: TurnRecord['status'];
  intent: string;
  finalMessageId?: string;
  usage?: UsageStats;
}

export interface ViewSubagent {
  id: string;
  parentTurnId?: string;
  agentId?: string;
  model?: string;
  name: string;
  task?: string;
  taskOmitted?: boolean;
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'unknown';
  background: SubagentBackground;
  progress?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  historyOmitted?: boolean;
}

export interface ViewTerminal {
  processId: string;
  command?: string;
  status?: string;
  output?: string;
  exitCode?: number;
  error?: string;
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
  modelSettings: 'next-send' | 'new-session' | 'unsupported';
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
  conversationId: string;
  queue: { id: string; text: string; images: number }[];
  changes: ViewChange[];
  planView: ViewPlan | null;
  timings: ViewTurnTiming[];
  subagents: ViewSubagent[];
  subagentWaiting: { startedAt: number; count?: number } | null;
  terminals: ViewTerminal[];
  terminalError?: string;
  additions: number;
  deletions: number;
  sessions: SessionSummary[];
  usage: UsageStats | null;
  permission: { token: string; request: PermissionRequest } | null;
  plan: { token: string; request: PlanRequest } | null;
  question: { token: string; request: QuestionRequest } | null;
  activeFile: { label: string; token: string } | null;
  locale: 'ja' | 'en';
  operationLabel?: 'rewind-check' | 'rewind-branch' | 'rewind-files' | 'rewind-prepare' | 'rewind-send';
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

export interface ViewCatalogParameter {
  id: string;
  label: string;
  role: 'effort' | 'context' | 'fast' | 'other';
  presentation: 'menu' | 'toggle';
  defaultValue?: string;
  values: { value: string; label: string; description?: string }[];
}

export interface ViewCatalogModel {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  parameters: ViewCatalogParameter[];
}

export interface ModelCatalogMessage {
  type: 'modelCatalog';
  requestId: number;
  provider: Provider;
  cwd: string;
  status: 'ready' | 'error';
  error?: string;
  models: ViewCatalogModel[];
  selectedModelId: string;
  selectedParams: { id: string; value: string }[];
}

export type HostToWebview =
  | StateMessage
  | ModelCatalogMessage
  | { type: 'retryPrepared'; id: string; text: string; images: ImageAttachment[]; attachments?: string[]; provider: Provider; cwd: string; conversationId?: string }
  | { type: 'copyResult'; requestId: string; ok: boolean }
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
