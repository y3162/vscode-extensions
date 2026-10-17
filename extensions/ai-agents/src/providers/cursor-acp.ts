import { lineChangeCounts } from '../diff-stats.js';
import type {
  AgentMode, AgentSession, AgentUpdate, ChatMessage, FileChange, PermissionDecision, PlanRequest, QuestionRequest, Selection, SessionSummary, SubagentRecord, TodoEntry,
} from '../types.js';
import type { SessionOptions } from './session-options.js';
import { acpCreatePlanPolicy, acpCreatePlanReleaseOutcome } from './plan-policy.js';
import { AssistantSegments } from './segments.js';
import { StdioJsonRpc } from './stdio-rpc.js';
import { classifyTool, toolStatus } from '../tool-kind.js';
import { extensionVersion } from '../version.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  const item = record(value);
  if (typeof item.text === 'string') return item.text;
  if (typeof item.stdout === 'string' || typeof item.stderr === 'string') return [item.stdout, item.stderr].filter((value) => typeof value === 'string').join('\n');
  if ('content' in item) return textOf(item.content);
  return '';
}

function optionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = record(item);
    const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
    return id ? [id] : [];
  });
}

function decisionOption(decision: PermissionDecision, advertised: string[]): string {
  const preferred = decision === 'deny'
    ? ['reject-once', 'reject', 'deny', 'decline']
    : decision === 'allow-session'
      ? ['allow-always', 'allow-session', 'allow']
      : ['allow-once', 'allow'];
  return preferred.find((id) => advertised.includes(id))
    ?? (decision === 'deny' ? 'reject-once' : decision === 'allow-session' ? 'allow-always' : 'allow-once');
}

function phaseTodos(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((phase) => todosOf(record(phase).todos));
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
    args: ['--sandbox', options.sandbox === 'disabled' ? 'disabled' : 'enabled', ...(options.model ? ['--model', options.model] : []), 'acp'],
    cwd: options.cwd,
  });
  const replay: ChatMessage[] = [];
  let sessionId = options.resumeId ?? '';
  let mode = options.mode ?? 'agent';
  let advertisedModels: { id: string; name: string }[] = [];
  let currentModelId = '';
  const selectionKey = (selection: Selection) => JSON.stringify([selection.model || 'auto', [...(selection.modelParams ?? [])].sort((a, b) => a.id.localeCompare(b.id))]);
  let activeSelectionKey = selectionKey(options);
  function readModelState(value: unknown): void {
    const body = record(value);
    const models = record(body.models);
    if (Array.isArray(models.availableModels)) advertisedModels = models.availableModels.flatMap((value) => {
      const model = record(value);
      return typeof model.modelId === 'string' ? [{ id: model.modelId, name: typeof model.name === 'string' ? model.name : '' }] : [];
    });
    if (typeof models.currentModelId === 'string') currentModelId = models.currentModelId;
    if (Array.isArray(body.configOptions)) {
      const model = body.configOptions.map(record).find((option) => option.id === 'model');
      if (model && typeof model.currentValue === 'string') currentModelId = model.currentValue;
      if (model && Array.isArray(model.options)) advertisedModels = model.options.flatMap((value) => {
        const option = record(value);
        return typeof option.value === 'string' ? [{ id: option.value, name: typeof option.name === 'string' ? option.name : '' }] : [];
      });
    }
  }
  async function applyRuntimeModel(selection: Selection): Promise<void> {
    const wanted = selection.model || 'auto';
    const candidates = advertisedModels.filter((model) => model.id === wanted || model.name === wanted
      || model.id.split('[')[0] === wanted || (wanted === 'auto' && /^(default|auto)\[/.test(model.id)));
    const selected = candidates.find((model) => {
      const params = new Map((model.id.match(/\[(.*)\]$/)?.[1] ?? '').split(',').filter(Boolean).map((pair) => {
        const split = pair.indexOf('=');
        return [pair.slice(0, split), pair.slice(split + 1)];
      }));
      return (selection.modelParams ?? []).every((parameter) => params.get(parameter.id) === parameter.value);
    });
    if (!selected) throw new Error(`Cursor ACP has not advertised this model and parameter combination: ${wanted}. Select an available CLI model variant.`);
    if (selected.id === currentModelId) { activeSelectionKey = selectionKey(selection); return; }
    try {
      const result = await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: selected.id });
      const acknowledged = Array.isArray(record(result).configOptions)
        ? (record(result).configOptions as unknown[]).map(record).find((option) => option.id === 'model')?.currentValue : undefined;
      if (acknowledged !== selected.id) throw new Error('Cursor ACP did not acknowledge the requested model variant.');
      readModelState(result);
      activeSelectionKey = selectionKey(selection);
    } catch (error) {
      // A request may have reached the backend even when its acknowledgment failed.
      // Resume the same session through a fresh connection before any further turn.
      await rpc.dispose();
      throw error;
    }
  }
  let turnOrdinal = 0;
  let thought = '';
  const lastAssistant = { current: undefined as AgentUpdate | undefined };
  const segments = { current: new AssistantSegments(true) };
  const sawPlan = { current: false };
  const emitLive = { current: undefined as ((update: AgentUpdate) => void) | undefined };
  const backgroundListeners = new Set<(update: AgentUpdate) => void>();
  const markReplayFinal = () => {
    const last = [...replay].reverse().find((message) => message.role === 'assistant');
    if (last) last.final = true;
  };
  const toolOutputs = new Map<string, string>();
  const tasks = new Map<string, SubagentRecord>();
  const fail = (error: unknown) => {
    emitLive.current?.({ id: 'acp-error', role: 'error', text: error instanceof Error ? error.message : String(error) });
  };

  const emitUpdate = (update: AgentUpdate, transcript: boolean) => {
    update = { ...update, backendTurnId: `acp-turn-${turnOrdinal}` };
    if (update.meta?.type === 'subagent' && backgroundListeners.size) {
      for (const listener of backgroundListeners) listener(update);
      return;
    }
    if (transcript && !emitLive.current) {
      const previous = replay.findIndex((m) => m.id === update.id);
      const message: ChatMessage = { id: update.id, role: update.role === 'tool' || update.role === 'status' || update.role === 'error' ? update.role : 'assistant', text: update.text, meta: update.meta, tool: update.tool, backendTurnId: update.backendTurnId, backendId: update.id };
      if (previous < 0) replay.push(message); else replay[previous] = message;
      return;
    }
    emitLive.current?.(update);
  };

  function markLiveFinal(): void {
    if (lastAssistant.current) emitUpdate({ ...lastAssistant.current, final: true }, false);
  }

  rpc.setHandlers({
    notification: (method, params) => {
      const body = record(params);
      if (method === 'session/update') handleUpdate(body.update ?? params, !emitLive.current);
      else if (method === 'cursor/task') handleTask(body, !emitLive.current);
      else if (method === 'cursor/update_todos') {
        const todos = todosOf(body.todos);
        if (todos.length) emitUpdate({ id: String(body.toolCallId ?? 'todos'), role: 'status', text: todos.map((todo) => `${todo.status}: ${todo.content}`).join('\n'), meta: { type: 'todo', todos } }, !emitLive.current);
      } else if (method === 'cursor/generate_image') {
        const filePath = typeof body.filePath === 'string' ? body.filePath : '';
        if (filePath) emitUpdate({ id: String(body.toolCallId ?? 'image'), role: 'status', text: filePath, meta: { type: 'image', imagePath: filePath } }, !emitLive.current);
      }
    },
    request: async (method, params) => {
      const body = record(params);
      try {
        if (method === 'cursor/task') {
          handleTask(body, !emitLive.current);
          return {};
        }
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
          const advertised = optionIds(body.options ?? tool.options);
          return { outcome: { outcome: 'selected', optionId: decisionOption(decision, advertised) } };
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
            todos: todosOf(body.todos).length ? todosOf(body.todos) : phaseTodos(body.phases),
          };
          sawPlan.current = true;
          emitUpdate({
            id: `plan-${request.id}`,
            role: 'status',
            text: request.plan,
            meta: {
              type: 'plan',
              plan: {
                ...(request.name ? { name: request.name } : {}),
                ...(request.overview ? { overview: request.overview } : {}),
                markdown: request.plan,
                todos: request.todos,
                source: 'acp-create-plan',
              },
            },
          }, false);
          if (acpCreatePlanPolicy === 'release') {
            const outcome = acpCreatePlanReleaseOutcome;
            return { outcome: outcome === 'rejected' ? { outcome: 'rejected', reason: 'The plan was saved. Implementation starts only from Build.' } : { outcome: 'cancelled' } };
          }
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
      const segment = chunk ? segments.current.push(chunk, kind === 'agent_message' ? 'snapshot' : 'delta') : undefined;
      if (segment) {
        lastAssistant.current = { id: transcript ? `history-${replay.filter((m) => m.role === 'user').length}:${segment.id}` : segment.id, role: 'assistant', text: segment.text };
        emitUpdate(lastAssistant.current, transcript);
      }
      return;
    }
    if (kind === 'plan') {
      const plan = textOf(update.content ?? update);
      if (!plan.trim()) return;
      sawPlan.current = true;
      emitUpdate({ id: 'acp-plan', role: 'status', text: plan, meta: { type: 'plan', plan: { markdown: plan, source: 'acp-create-plan' } } }, transcript);
      return;
    }
    if (kind === 'current_mode_update') return;
    if (kind === 'agent_thought_chunk') {
      const chunk = textOf(update.content ?? update);
      if (!chunk) return;
      thought += chunk;
      emitUpdate({ id: 'thought', role: 'status', text: thought, meta: { type: 'thinking' } }, transcript);
      return;
    }
    if (kind === 'user_message_chunk' || kind === 'user_message') {
      const text = textOf(update.content ?? update);
      if (text && transcript) {
        const previous = replay.at(-1);
        if (kind === 'user_message_chunk' && previous?.role === 'user') previous.text += text;
        else { markReplayFinal(); turnOrdinal++; replay.push({ id: `acp-turn-${turnOrdinal}:user`, backendTurnId: `acp-turn-${turnOrdinal}`, role: 'user', text }); segments.current = new AssistantSegments(true); thought = ''; }
      }
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      segments.current.interrupt();
      const id = String(update.toolCallId ?? 'tool');
      if (tasks.has(id) || record(update.rawInput)._toolName === 'task' || (typeof update.title === 'string' && /^Task:/i.test(update.title))) {
        handleTask({ ...record(update.rawOutput), ...update }, transcript);
        return;
      }
      const title = typeof update.title === 'string' ? update.title : 'tool';
      const status = typeof update.status === 'string' ? update.status : kind;
      const files = filesFrom(update);
      const kindName = typeof update.kind === 'string' ? update.kind : '';
      const target = files[0]?.path;
      const output = textOf(update.content) || textOf(update.rawOutput);
      if (output) toolOutputs.set(id, output);
      emitUpdate({
        id, role: 'tool', text: toolOutputs.get(id) ?? `${status}: ${title}`,
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
    const content = Array.isArray(update.content) ? update.content : [];
    const files: FileChange[] = [];
    const toolKind = typeof update.kind === 'string' ? update.kind.toLowerCase() : '';
    for (const block of content) {
      const item = record(block);
      const diff = record(item.type === 'diff' ? item : item.content);
      if (item.type !== 'diff' && record(item.content).type !== 'diff') continue;
      const filePath = typeof diff.path === 'string' ? diff.path : '';
      if (!filePath) continue;
      const previous = typeof diff.oldText === 'string' || diff.oldText === null ? diff.oldText as string | null : undefined;
      const next = typeof diff.newText === 'string' ? diff.newText : undefined;
      const counts = previous !== undefined && next !== undefined ? lineChangeCounts(previous ?? '', next) : undefined;
      const kind: FileChange['kind'] = toolKind.includes('delete') ? 'delete'
        : previous === null ? 'add'
          : toolKind.includes('move') ? 'rename' : 'update';
      files.push({
        path: filePath,
        kind,
        ...(previous !== undefined ? { previousText: previous } : {}),
        ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {}),
      });
    }
    return files;
  }

  function taskStatus(body: Record<string, unknown>): SubagentRecord['status'] {
    const raw = typeof body.status === 'string' ? body.status : '';
    if (/cancel|interrupt/i.test(raw)) return 'cancelled';
    if (/fail|error/i.test(raw)) return 'error';
    if (/complete|success|done/i.test(raw) || typeof body.durationMs === 'number') return 'completed';
    return /pending|progress|running|start/i.test(raw) ? 'running' : 'unknown';
  }

  function handleTask(body: Record<string, unknown>, transcript: boolean): void {
    const id = String(body.toolCallId ?? '');
    if (!id) return;
    const previous = tasks.get(id);
    const description = typeof body.description === 'string' ? body.description : previous?.name ?? 'Subagent';
    const subagentType = body.subagentType;
    const name = typeof subagentType === 'string' ? subagentType
      : typeof record(subagentType).custom === 'string' ? String(record(subagentType).custom) : description;
    const background = typeof body.isBackground === 'boolean' ? body.isBackground : previous?.background ?? 'unknown';
    const status = taskStatus(body);
    const subagent: SubagentRecord = {
      ...previous, id, name, background,
      status: status === 'unknown' ? previous?.status ?? status : status,
      ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.prompt === 'string' ? { task: body.prompt } : {}),
      ...(typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : {}),
      ...(status === 'running' && !previous?.startedAt ? { startedAt: Date.now() } : {}),
      ...(['completed', 'error', 'cancelled'].includes(status) ? { endedAt: Date.now() } : {}),
    };
    tasks.set(id, subagent);
    emitUpdate({
      id,
      role: 'status',
      text: description,
      meta: {
        type: 'subagent',
        subagent,
      },
    }, transcript);
  }

  async function applyRuntimeMode(next: AgentMode): Promise<void> {
    await rpc.request('session/set_mode', { sessionId, modeId: next });
    mode = next;
    await rpc.request('session/set_config_option', { sessionId, configId: 'mode', value: next }).catch(() => undefined);
  }

  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-agents', version: extensionVersion },
    }, options.signal);
    try {
      await rpc.request('authenticate', { methodId: 'cursor_login' }, options.signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/auth|login|logged/i.test(message)) {
        throw new Error(`Cursor CLI にログインしていません。ターミナルで agent login を実行してください。 ${message}`);
      }
      throw error;
    }
    if (options.resumeId) {
      readModelState(await rpc.request('session/load', { sessionId: options.resumeId, cwd: options.cwd, mcpServers: [] }, options.signal));
      sessionId = options.resumeId;
      markReplayFinal();
    } else {
      const created = record(await rpc.request('session/new', {
        cwd: options.cwd,
        mcpServers: [],
        ...(mode ? { mode } : {}),
      }, options.signal));
      readModelState(created);
      sessionId = typeof created.sessionId === 'string' ? created.sessionId : '';
    }
    if (!sessionId) throw new Error('Cursor ACP did not return a session id.');
    if (options.modelParams?.length || (options.model && advertisedModels.length)) await applyRuntimeModel(options);
    // Loading a session can restore its previous Plan/Ask mode. Reconcile Agent
    // too, before trusting the local mode used to skip later mode changes.
    if (options.resumeId || mode !== 'agent') await applyRuntimeMode(mode);
    options.onIdentity?.({
      id: sessionId,
      title: 'Cursor ACP',
      updatedAt: new Date().toISOString(),
      provider: 'cursor',
      cwd: options.cwd,
    });
  } catch (error) {
    await rpc.dispose();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes('exited') || message.includes('ENOENT')
      ? `Cursor CLI を起動できません。ACP を使う場合は agent コマンドのパスを確認してください。 ${message}`
      : message);
  }

  return {
    sessionId,
    subscribeBackgroundUpdates(emit) { backgroundListeners.add(emit); return () => backgroundListeners.delete(emit); },
    get closed() { return rpc.isClosed; },
    async setModel(selection) { await applyRuntimeModel(selection); },
    async setMode(next) { await applyRuntimeMode(next); },
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
    async run(prompt, signal, emit, extras, turn) {
      turnOrdinal++;
      emitLive.current = emit;
      thought = '';
      segments.current = new AssistantSegments(true);
      sawPlan.current = false;
      lastAssistant.current = undefined;
      const blocks: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
      for (const image of extras?.images ?? []) blocks.push({ type: 'image', mimeType: image.mimeType, data: image.data });
      const aborted = () => { void rpc.notify('session/cancel', { sessionId }); };
      signal.addEventListener('abort', aborted, { once: true });
      try {
        if (turn?.selection && selectionKey(turn.selection) !== activeSelectionKey) await applyRuntimeModel(turn.selection);
        if (turn?.mode && turn.mode !== mode) await applyRuntimeMode(turn.mode);
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        await rpc.request('session/prompt', { sessionId, prompt: blocks }, signal);
        // ACP chunks are deltas; end_turn is the authoritative completion boundary.
        if (!signal.aborted) markLiveFinal();
        const planText = segments.current.fullText().trim();
        if ((turn?.mode ?? mode) === 'plan' && !sawPlan.current && planText && !signal.aborted) {
          emit({ id: 'plan-text', role: 'status', text: planText, meta: { type: 'plan', plan: { markdown: planText, source: 'assistant-text' } } });
        }
        options.onIdentity?.({ id: sessionId, title: prompt.slice(0, 80) || 'Cursor ACP', updatedAt: new Date().toISOString(), provider: 'cursor', cwd: options.cwd });
      } finally {
        signal.removeEventListener('abort', aborted);
        emitLive.current = undefined;
      }
    },
    async dispose() { backgroundListeners.clear(); await rpc.dispose(); },
  };
}
