export type Provider = 'codex' | 'cursor';
export type Backend = 'sdk' | 'acp' | 'app-server';
export type AgentMode = 'agent' | 'plan' | 'ask';
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
  kind: 'add' | 'update' | 'delete';
  previousText?: string | null;
  diff?: string;
  additions?: number;
  deletions?: number;
}

export interface TodoEntry {
  content: string;
  status: string;
}

export interface UpdateMeta {
  type: 'usage' | 'files' | 'thinking' | 'todo' | 'image' | 'task';
  usage?: UsageStats;
  files?: FileChange[];
  todos?: TodoEntry[];
  imagePath?: string;
  task?: string;
  append?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'error';
  text: string;
  meta?: UpdateMeta;
  tool?: ToolInfo;
  at?: number;
  attachments?: string[];
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
}

export interface AgentInteractions {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  requestPlan(request: PlanRequest): Promise<'accepted' | 'rejected'>;
  requestAnswers(request: QuestionRequest): Promise<Record<string, string[]>>;
}

export interface AgentSession {
  run(prompt: string, signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras): Promise<void>;
  dispose(): Promise<void>;
  setMode?(mode: AgentMode): Promise<void>;
  steer?(text: string): Promise<boolean>;
  loadTranscript?(emit: (message: ChatMessage) => void): Promise<void>;
  fork?(): Promise<string | undefined>;
  compact?(): Promise<void>;
  review?(target: 'uncommitted' | 'base', emit: (update: AgentUpdate) => void, signal: AbortSignal): Promise<void>;
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
