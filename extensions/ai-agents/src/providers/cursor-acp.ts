import type {
  AgentSession, AgentUpdate, ChatMessage, FileChange, PermissionDecision, PlanRequest, QuestionRequest, SessionSummary, TodoEntry,
} from '../types.js';
import type { SessionOptions } from './session-options.js';
import { mergeStreamText } from './stream-text.js';
import { StdioJsonRpc } from './stdio-rpc.js';
import { classifyTool, toolStatus } from '../tool-kind.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  const item = record(value);
  if (typeof item.text === 'string') return item.text;
  if ('content' in item) return textOf(item.content);
  return '';
}

function decisionOption(decision: PermissionDecision): string {
  if (decision === 'deny') return 'reject-once';
  return 'allow-once';
}

function todosOf(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const todo = record(item);
    const content = typeof todo.content === 'string' ? todo.content : typeof todo.text === 'string' ? todo.text : '';
    if (!content) return [];
    const status = typeof todo.status === 'string' ? todo.status : 'pending';
    return [{ content, status }];
  });
}

export async function createCursorAcpSession(options: SessionOptions): Promise<AgentSession> {
  const rpc = new StdioJsonRpc({
    command: options.agentPath || 'agent',
    args: ['--sandbox', options.sandbox === 'disabled' ? 'disabled' : 'enabled', 'acp'],
    cwd: options.cwd,
  });
  const replay: ChatMessage[] = [];
  let sessionId = options.resumeId ?? '';
  let mode = options.mode ?? 'agent';
  let assistant = '';
  let thought = '';
  let assistantId = 'assistant';
  const emitLive = { current: undefined as ((update: AgentUpdate) => void) | undefined };
  const fail = (error: unknown) => {
    emitLive.current?.({ id: 'acp-error', role: 'error', text: error instanceof Error ? error.message : String(error) });
  };

  const emitUpdate = (update: AgentUpdate, transcript: boolean) => {
    if (transcript && !emitLive.current) {
      replay.push({ id: update.id, role: update.role === 'tool' || update.role === 'status' || update.role === 'error' ? update.role : 'assistant', text: update.text, meta: update.meta });
      return;
    }
    emitLive.current?.(update);
  };

  rpc.setHandlers({
    notification: (method, params) => {
      if (method === 'session/update') handleUpdate(record(params).update ?? params, !emitLive.current);
    },
    request: async (method, params) => {
      const body = record(params);
      try {
        if (method === 'session/request_permission') {
          const tool = record(body.toolCall);
          const title = typeof tool.title === 'string' ? tool.title : typeof body.title === 'string' ? body.title : 'Tool';
          const kindText = `${typeof tool.kind === 'string' ? tool.kind : ''} ${title}`.toLowerCase();
          const kind = kindText.includes('shell') || kindText.includes('exec') || kindText.includes('command') ? 'shell'
            : kindText.includes('write') || kindText.includes('edit') || kindText.includes('delete') ? 'write'
              : kindText.includes('read') || kindText.includes('search') ? 'read'
                : kindText.includes('mcp') ? 'mcp' : 'other';
          const decision = options.interactions
            ? await options.interactions.requestPermission({ id: String(body.toolCallId ?? title), title, detail: textOf(tool.rawInput) || title, kind })
            : 'deny';
          return { outcome: { outcome: 'selected', optionId: decisionOption(decision) } };
        }
        if (method === 'cursor/ask_question') {
          const request: QuestionRequest = {
            id: String(body.toolCallId ?? 'question'),
            title: typeof body.title === 'string' ? body.title : undefined,
            questions: Array.isArray(body.questions) ? body.questions.flatMap((item) => {
              const question = record(item);
              const id = typeof question.id === 'string' ? question.id : '';
              const prompt = typeof question.prompt === 'string' ? question.prompt : '';
              if (!id || !prompt) return [];
              const options = Array.isArray(question.options) ? question.options.flatMap((option) => {
                const choice = record(option);
                const optionId = typeof choice.id === 'string' ? choice.id : '';
                const label = typeof choice.label === 'string' ? choice.label : optionId;
                return optionId ? [{ id: optionId, label }] : [];
              }) : [];
              return [{ id, prompt, options, allowMultiple: question.allowMultiple === true }];
            }) : [],
          };
          const answers = options.interactions ? await options.interactions.requestAnswers(request) : {};
          return {
            outcome: {
              outcome: 'answered',
              answers: Object.entries(answers).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })),
            },
          };
        }
        if (method === 'cursor/create_plan') {
          const request: PlanRequest = {
            id: String(body.toolCallId ?? 'plan'),
            name: typeof body.name === 'string' ? body.name : undefined,
            overview: typeof body.overview === 'string' ? body.overview : undefined,
            plan: typeof body.plan === 'string' ? body.plan : '',
            todos: todosOf(body.todos),
          };
          const decision = options.interactions ? await options.interactions.requestPlan(request) : 'rejected';
          return { outcome: { outcome: decision === 'accepted' ? 'accepted' : 'rejected' } };
        }
      } catch (error) {
        fail(error);
        if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
        if (method === 'cursor/create_plan') return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'cancelled' } };
      }
      return {};
    },
  });

  function handleUpdate(value: unknown, transcript: boolean): void {
    const update = record(value);
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      const chunk = textOf(update.content ?? update);
      if (!chunk) return;
      assistant += kind === 'agent_message' && assistant.endsWith(chunk) ? '' : chunk;
      if (kind === 'agent_message') assistant = chunk || assistant;
      emitUpdate({ id: assistantId, role: 'assistant', text: assistant }, transcript);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const chunk = textOf(update.content ?? update);
      if (!chunk) return;
      thought = mergeStreamText(thought, chunk);
      emitUpdate({ id: `thought-${assistantId}`, role: 'status', text: thought, meta: { type: 'thinking' } }, transcript);
      return;
    }
    if (kind === 'user_message_chunk' || kind === 'user_message') {
      const text = textOf(update.content ?? update);
      if (text) replay.push({ id: `user-${replay.length}`, role: 'user', text });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update.toolCallId ?? 'tool');
      const title = typeof update.title === 'string' ? update.title : 'tool';
      const status = typeof update.status === 'string' ? update.status : kind;
      const files = filesFrom(update);
      const kindName = typeof update.kind === 'string' ? update.kind : '';
      const target = files[0]?.path;
      emitUpdate({
        id, role: 'tool', text: `${status}: ${title}`,
        tool: {
          kind: classifyTool(`${kindName} ${title}`, target),
          name: title,
          status: toolStatus(status),
          ...(target ? { target } : {}),
        },
        ...(files.length ? { meta: { type: 'files' as const, files } } : {}),
      }, transcript);
      return;
    }
    if (kind === 'cursor/update_todos' || update.todos) {
      const todos = todosOf(update.todos);
      if (todos.length) emitUpdate({ id: 'todos', role: 'status', text: todos.map((todo) => `${todo.status}: ${todo.content}`).join('\n'), meta: { type: 'todo', todos } }, transcript);
    }
  }

  function filesFrom(update: Record<string, unknown>): FileChange[] {
    const locations = Array.isArray(update.locations) ? update.locations : [];
    const content = Array.isArray(update.content) ? update.content : [];
    const files: FileChange[] = [];
    for (const block of content) {
      const item = record(block);
      const diff = record(item.type === 'diff' ? item : item.content);
      if (item.type !== 'diff' && record(item.content).type !== 'diff') continue;
      const filePath = typeof diff.path === 'string' ? diff.path : '';
      if (!filePath) continue;
      files.push({
        path: filePath,
        kind: 'update',
        ...(typeof diff.oldText === 'string' || diff.oldText === null ? { previousText: diff.oldText as string | null } : {}),
        ...(typeof diff.newText === 'string' && typeof diff.oldText === 'string' ? { diff: `--- a/${filePath}\n+++ b/${filePath}\n${diff.newText}` } : {}),
      });
    }
    if (!files.length) {
      for (const location of locations) {
        const filePath = typeof record(location).path === 'string' ? String(record(location).path) : '';
        if (filePath) files.push({ path: filePath, kind: 'update' });
      }
    }
    return files;
  }

  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-agents', version: '0.5.0' },
    });
    await rpc.request('authenticate', { methodId: 'cursor_login' });
    if (options.resumeId) {
      await rpc.request('session/load', { sessionId: options.resumeId, cwd: options.cwd, mcpServers: [] });
      sessionId = options.resumeId;
    } else {
      const created = record(await rpc.request('session/new', {
        cwd: options.cwd,
        mcpServers: [],
        ...(mode ? { mode } : {}),
      }));
      sessionId = typeof created.sessionId === 'string' ? created.sessionId : '';
    }
    if (!sessionId) throw new Error('Cursor ACP did not return a session id.');
    options.onIdentity?.({
      id: sessionId,
      title: 'Cursor ACP',
      updatedAt: new Date().toISOString(),
      provider: 'cursor',
      cwd: options.cwd,
    });
  } catch (error) {
    await rpc.dispose();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes('exited') || message.includes('ENOENT')
      ? `Cursor CLI を起動できません。ACP を使う場合は agent コマンドのパスを確認してください。 ${message}`
      : message);
  }

  return {
    sessionId,
    async setMode(next) {
      mode = next;
      await rpc.request('session/set_mode', { sessionId, modeId: next }).catch(() => undefined);
      await rpc.request('session/set_config_option', { sessionId, configId: 'mode', value: next });
    },
    async loadTranscript(emit) {
      for (const message of replay) emit(message);
    },
    async listSessions() {
      const listed = record(await rpc.request('session/list', { cwd: options.cwd }));
      const sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
      return sessions.flatMap((item): SessionSummary[] => {
        const session = record(item);
        const id = typeof session.sessionId === 'string' ? session.sessionId : '';
        if (!id) return [];
        return [{
          id,
          title: typeof session.title === 'string' && session.title ? session.title : id,
          updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
          provider: 'cursor',
          cwd: options.cwd,
        }];
      });
    },
    async run(prompt, signal, emit, extras) {
      emitLive.current = emit;
      assistant = '';
      thought = '';
      assistantId = `assistant-${Date.now()}`;
      const blocks: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
      for (const image of extras?.images ?? []) blocks.push({ type: 'image', mimeType: image.mimeType, data: image.data });
      const aborted = () => { void rpc.notify('session/cancel', { sessionId }); };
      signal.addEventListener('abort', aborted, { once: true });
      try {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        await rpc.request('session/prompt', { sessionId, prompt: blocks }, signal);
        options.onIdentity?.({ id: sessionId, title: prompt.slice(0, 80) || 'Cursor ACP', updatedAt: new Date().toISOString(), provider: 'cursor', cwd: options.cwd });
      } finally {
        signal.removeEventListener('abort', aborted);
        emitLive.current = undefined;
      }
    },
    async dispose() { await rpc.dispose(); },
  };
}
