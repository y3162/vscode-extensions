export type Provider = 'codex' | 'cursor';
export type Backend = 'sdk' | 'acp' | 'app-server';
export type AgentMode = 'agent' | 'plan' | 'ask';
export type ModelApplyMode = 'next-send' | 'new-session' | 'unsupported';
export type ModelParameterRole = 'effort' | 'context' | 'fast' | 'other';
export type ModelParameterPresentation = 'menu' | 'toggle';
export type ConnectionStatus =
  | 'disconnected'
  | 'auth_required'
  | 'connecting'
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'error'
  | 'restoring';

export interface Selection {
  provider: Provider;
  cwd: string;
  model: string;
  modelParams?: { id: string; value: string }[];
}

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  aliases?: string[];
  defaultParams?: { id: string; value: string }[];
  parameters?: ModelParameter[];
  presets?: {
    label: string;
    description?: string;
    isDefault?: boolean;
    params: { id: string; value: string }[];
  }[];
}

export interface ModelParameter {
  id: string;
  label: string;
  role?: ModelParameterRole;
  presentation?: ModelParameterPresentation;
  defaultValue?: string;
  values: { value: string; label: string; description?: string }[];
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ImageAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

export interface SendExtras {
  displayText?: string;
  images?: ImageAttachment[];
  attachments?: string[];
}

export interface ToolInfo {
  kind: 'read' | 'edit' | 'search' | 'shell' | 'git' | 'mcp' | 'subagent' | 'other';
  name: string;
  status: 'running' | 'completed' | 'error';
  target?: string;
  exitCode?: number;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  extras?: SendExtras;
}

export interface FileChange {
  path: string;
  kind: 'add' | 'update' | 'delete' | 'rename';
  oldPath?: string;
  previousText?: string | null;
  diff?: string;
  additions?: number;
  deletions?: number;
}

export interface TodoEntry {
  content: string;
  status: string;
}

export type PlanPhase = 'idle' | 'planning' | 'ready' | 'revising' | 'building' | 'implemented';
export type PlanSource = 'acp-create-plan' | 'sdk-createPlan' | 'app-server-plan' | 'assistant-text';
export type TurnIntent = 'chat' | 'plan' | 'revise' | 'build';
export type SubagentBackground = boolean | 'unknown';

export interface PlanDocument {
  id: string;
  revision: number;
  name?: string;
  overview?: string;
  markdown: string;
  todos: TodoEntry[];
  files?: string[];
  source: PlanSource;
  createdAt: number;
  sessionId?: string;
  restored?: boolean;
}

export interface PlanRevision {
  revision: number;
  createdAt: number;
  source: PlanSource;
  name?: string;
  markdown: string;
}

export interface PlanBuild {
  selection: Selection;
  label?: string;
  startedAt?: number;
}

export interface PlanState {
  phase: PlanPhase;
  current?: PlanDocument;
  draft?: PlanDocument;
  revisions: PlanRevision[];
  build?: PlanBuild;
  error?: string;
}

export interface TurnRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  waitMs: number;
  mode: AgentMode;
  model: string;
  intent: TurnIntent;
  finalMessageId?: string;
}

export interface TurnOptions {
  intent: TurnIntent;
  mode: AgentMode;
  selection: Selection;
}

export interface SubagentRecord {
  id: string;
  parentTurnId?: string;
  name: string;
  task?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  background: SubagentBackground;
  resultPreview?: string;
}

export interface TerminalRecord {
  processId: string;
  command?: string;
  status?: string;
}

export interface UpdateMeta {
  type: 'usage' | 'files' | 'thinking' | 'todo' | 'image' | 'task' | 'plan' | 'subagent' | 'terminals';
  usage?: UsageStats;
  files?: FileChange[];
  todos?: TodoEntry[];
  imagePath?: string;
  task?: string;
  append?: boolean;
  plan?: { name?: string; overview?: string; markdown: string; todos?: TodoEntry[]; files?: string[]; source: PlanSource };
  subagent?: SubagentRecord;
  terminals?: TerminalRecord[];
  final?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'error';
  text: string;
  meta?: UpdateMeta;
  tool?: ToolInfo;
  at?: number;
  attachments?: string[];
  final?: boolean;
}

export type AgentUpdate = Omit<ChatMessage, 'role'> & {
  role: Exclude<ChatMessage['role'], 'user'>;
};

export interface PermissionRequest {
  id: string;
  title: string;
  detail: string;
  kind: 'shell' | 'write' | 'read' | 'mcp' | 'network' | 'other';
}

export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny';

export interface PlanRequest {
  id: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: TodoEntry[];
}

export interface QuestionPrompt {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  title?: string;
  questions: QuestionPrompt[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  provider: Provider;
  cwd?: string;
  activity?: 'idle' | 'running' | 'waiting' | 'error';
}

export interface AgentInteractions {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  requestPlan(request: PlanRequest): Promise<'accepted' | 'rejected'>;
  requestAnswers(request: QuestionRequest): Promise<Record<string, string[]>>;
}

export interface AgentSession {
  run(prompt: string, signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras, turn?: TurnOptions): Promise<void>;
  dispose(): Promise<void>;
  setMode?(mode: AgentMode): Promise<void>;
  setModel?(selection: Selection): void;
  steer?(text: string): Promise<boolean>;
  loadTranscript?(emit: (message: ChatMessage) => void): Promise<void>;
  fork?(): Promise<string | undefined>;
  compact?(): Promise<void>;
  review?(target: 'uncommitted' | 'base', emit: (update: AgentUpdate) => void, signal: AbortSignal): Promise<void>;
  listBackgroundTerminals?(): Promise<TerminalRecord[]>;
  terminateBackgroundTerminal?(processId: string): Promise<void>;
  listSessions?(): Promise<SessionSummary[]>;
  rateLimits?(): Promise<string>;
  instructions?(): Promise<string>;
  sessionId?: string;
  /** True after the backing process has exited. A later send must not reuse it. */
  readonly closed?: boolean;
}

export interface ChatState {
  selection: Selection;
  busy: boolean;
  messages: ChatMessage[];
  queue: QueuedPrompt[];
  status: ConnectionStatus;
  usage: UsageStats | null;
  changes: FileChange[];
  todos: TodoEntry[];
  sessions: SessionSummary[];
  autoApprove: boolean;
  pendingPermission: PermissionRequest | null;
  pendingPlan: PlanRequest | null;
  pendingQuestion: QuestionRequest | null;
  plan: PlanState;
  turns: TurnRecord[];
  subagents: SubagentRecord[];
  terminals: TerminalRecord[];
}

export function emptyPlanState(): PlanState {
  return { phase: 'idle', revisions: [] };
}

export function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|token|authorization|secret|password|bearer)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
}
