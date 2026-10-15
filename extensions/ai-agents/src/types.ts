export type Provider = 'codex' | 'cursor';

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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'error';
  text: string;
}

export type AgentUpdate = Omit<ChatMessage, 'role'> & {
  role: Exclude<ChatMessage['role'], 'user'>;
};

export interface AgentSession {
  run(prompt: string, signal: AbortSignal, emit: (update: AgentUpdate) => void): Promise<void>;
  dispose(): Promise<void>;
}

export interface ChatState {
  selection: Selection;
  busy: boolean;
  messages: ChatMessage[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
