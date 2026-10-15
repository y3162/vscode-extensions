import { writeImageFiles } from '../images.js';
import type {
  AgentSession, AgentUpdate, ChatMessage, FileChange, PermissionDecision, SessionSummary, TodoEntry, UsageStats,
} from '../types.js';
import { codexSpawn } from './codex-binary.js';
import type { SessionOptions } from './session-options.js';
import { StdioJsonRpc } from './stdio-rpc.js';
import { describedTool } from './tools.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  const item = record(value);
  if (typeof item.text === 'string') return item.text;
  if (typeof item.command === 'string') return item.command;
  if (typeof item.query === 'string') return item.query;
  if (typeof item.message === 'string') return item.message;
  return '';
}

function itemType(item: Record<string, unknown>): string {
  return typeof item.type === 'string' ? item.type : '';
}

function decisionOf(decision: PermissionDecision): string {
  if (decision === 'deny') return 'decline';
  if (decision === 'allow-session') return 'acceptForSession';
  return 'accept';
}

function usageOf(value: unknown): UsageStats | undefined {
  const usage = record(value);
  const source = record(usage.last ?? usage.total ?? usage);
  const input = source.inputTokens ?? source.input_tokens;
  const output = source.outputTokens ?? source.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
    cachedInputTokens: typeof source.cachedInputTokens === 'number' ? source.cachedInputTokens : undefined,
    reasoningTokens: typeof (source.reasoningOutputTokens ?? source.reasoningTokens) === 'number'
      ? Number(source.reasoningOutputTokens ?? source.reasoningTokens) : undefined,
    totalTokens: typeof source.totalTokens === 'number' ? source.totalTokens : undefined,
  };
}

function filesOf(item: Record<string, unknown>): FileChange[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.flatMap((change) => {
    const entry = record(change);
    const filePath = typeof entry.path === 'string' ? entry.path : '';
    if (!filePath) return [];
    const kind = entry.kind === 'add' || entry.kind === 'delete' ? entry.kind : 'update';
    return [{ path: filePath, kind, ...(typeof entry.diff === 'string' ? { diff: entry.diff } : {}) }];
  });
}

function todosOf(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const todo = record(item);
    const content = typeof todo.content === 'string' ? todo.content : typeof todo.text === 'string' ? todo.text : typeof todo.step === 'string' ? todo.step : '';
    if (!content) return [];
    const status = typeof todo.status === 'string' ? todo.status : todo.completed === true ? 'completed' : 'pending';
    return [{ content, status }];
  });
}

function messagesFrom(value: unknown): ChatMessage[] {
  const root = record(value);
  const thread = record(root.thread ?? root);
  const turns = Array.isArray(thread.turns) ? thread.turns : Array.isArray(root.turns) ? root.turns : [];
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(record(turn).items) ? record(turn).items as unknown[] : [];
    for (const raw of items) {
      const item = record(raw);
      const type = itemType(item);
      const text = textOf(item);
      if (!text) continue;
      const role = type.toLowerCase().includes('user') ? 'user'
        : type.toLowerCase().includes('error') ? 'error'
          : type.toLowerCase().includes('agent') || type.toLowerCase().includes('message') ? 'assistant' : 'tool';
      messages.push({ id: typeof item.id === 'string' ? item.id : `history-${messages.length}`, role, text });
    }
  }
  return messages;
}

export async function createCodexAppServerSession(options: SessionOptions): Promise<AgentSession> {
  const key = options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  const rpc = new StdioJsonRpc(codexSpawn(options.codexPath, ['app-server', '--listen', 'stdio://'], options.cwd, key));
  let threadId = options.resumeId ?? '';
  let turnId = '';
  let mode = options.mode ?? 'agent';
  const buffers = new Map<string, string>();
  const finished = new Map<string, Error | null>();
  let waiter: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  const replay = messagesFrom({});
  let instructionSources: string[] = [];
  const emitLive = { current: undefined as ((update: AgentUpdate) => void) | undefined };
  const effort = options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value;

  const finish = (id: string, error: Error | null) => {
    if (!id) return;
    finished.set(id, error);
    if (waiter?.id !== id) return;
    const current = waiter;
    waiter = null;
    if (error) current.reject(error);
    else current.resolve();
  };

  const emitItem = (item: Record<string, unknown>) => {
    const emit = emitLive.current;
    if (!emit) return;
    const type = itemType(item).toLowerCase();
    const id = typeof item.id === 'string' ? item.id : type || 'item';
    const text = textOf(item) || buffers.get(id) || '';
    if (type.includes('file')) {
      const files = filesOf(item);
      const body = text || files.map((file) => `${file.kind}: ${file.path}`).join('\n');
      emit({
        id, role: 'tool', text: body, tool: describedTool('edit', body, typeof item.status === 'string' ? item.status : 'completed'),
        ...(files.length ? { meta: { type: 'files', files } } : {}),
      });
      return;
    }
    if (type.includes('todo') || type === 'plan') {
      const todos = todosOf(item.items ?? item.todos ?? item.plan);
      emit({ id, role: 'status', text: text || todos.map((todo) => `${todo.status}: ${todo.content}`).join('\n'), ...(todos.length ? { meta: { type: 'todo', todos } } : {}) });
      return;
    }
    if (type.includes('agent') || type.includes('reasoning')) {
      if (text) emit({ id, role: type.includes('reasoning') ? 'status' : 'assistant', text, ...(type.includes('reasoning') ? { meta: { type: 'thinking' as const } } : {}) });
      return;
    }
    if (type.includes('error')) {
      if (text) emit({ id, role: 'error', text });
      return;
    }
    if (text) {
      const status = typeof item.status === 'string' ? item.status : 'completed';
      const name = type.includes('command') ? 'shell' : type || 'tool';
      emit({ id, role: 'tool', text: `${type || 'tool'}: ${text}`, tool: describedTool(name, text, status) });
    }
  };

  rpc.setHandlers({
    notification: (method, params) => {
      const body = record(params);
      const item = record(body.item);
      if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
        const id = typeof body.itemId === 'string' ? body.itemId : 'stream';
        const delta = typeof body.delta === 'string' ? body.delta : '';
        buffers.set(id, `${buffers.get(id) ?? ''}${delta}`);
        emitItem({
          id,
          type: method.includes('command') ? 'commandExecution' : method.includes('reasoning') ? 'reasoning' : method.includes('plan') ? 'plan' : 'agentMessage',
          text: buffers.get(id),
          status: 'in_progress',
        });
        return;
      }
      if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') emitItem(item);
      if (method === 'turn/completed' || method === 'turn/diff/updated') {
        const id = typeof body.turnId === 'string' ? body.turnId : turnId;
        if (typeof body.diff === 'string' && emitLive.current) {
          emitLive.current({ id: `${id}:diff`, role: 'tool', text: 'diff updated', meta: { type: 'files', files: [{ path: 'turn.diff', kind: 'update', diff: body.diff }] } });
        }
        const usage = usageOf(body.usage ?? body.tokenUsage);
        if (usage && emitLive.current) emitLive.current({ id: `${id}:usage`, role: 'status', text: '', meta: { type: 'usage', usage } });
        if (method === 'turn/completed') finish(id, null);
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = usageOf(body.tokenUsage ?? body);
        if (usage && emitLive.current) emitLive.current({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage } });
      }
      if (method === 'turn/plan/updated') {
        const todos = todosOf(body.plan);
        emitLive.current?.({ id: 'plan', role: 'status', text: typeof body.explanation === 'string' ? body.explanation : '', meta: { type: 'todo', todos } });
      }
      if (method === 'error') finish(turnId, new Error(typeof body.message === 'string' ? body.message : 'Codex app-server error'));
    },
    request: async (method, params) => {
      const body = record(params);
      if (!options.interactions) return { decision: 'decline' };
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval') {
        const title = typeof body.command === 'string' ? body.command : typeof body.reason === 'string' ? body.reason : method;
        const kind = method.includes('file') ? 'write' : method.includes('permission') ? 'network' : 'shell';
        const decision = await options.interactions.requestPermission({
          id: String(body.approvalId ?? body.itemId ?? title),
          title,
          detail: typeof body.reason === 'string' ? body.reason : title,
          kind,
        });
        return { decision: decisionOf(decision) };
      }
      if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(body.questions) ? body.questions.flatMap((item) => {
          const question = record(item);
          const id = typeof question.id === 'string' ? question.id : '';
          const prompt = typeof question.question === 'string' ? question.question : typeof question.header === 'string' ? question.header : '';
          if (!id || !prompt) return [];
          const choices = Array.isArray(question.options) ? question.options.flatMap((option) => {
            const choice = record(option);
            const label = typeof choice.label === 'string' ? choice.label : '';
            return label ? [{ id: label, label }] : [];
          }) : [];
          return [{ id, prompt, options: choices }];
        }) : [];
        const answers = await options.interactions.requestAnswers({ id: String(body.itemId ?? 'question'), questions });
        return { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) };
      }
      return {};
    },
  });

  const identify = (title: string) => {
    if (!threadId) return;
    options.onIdentity?.({ id: threadId, title, updatedAt: new Date().toISOString(), provider: 'codex', cwd: options.cwd });
  };

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'ai_agents_vscode', title: 'AI Agents', version: '0.5.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify('initialized', {});
    const config: Record<string, unknown> = {};
    if (effort) config.model_reasoning_effort = effort;
    if (options.webSearch) config.web_search = options.webSearch;
    if (options.network) config.sandbox_workspace_write = { network_access: true };
    const params = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: options.approval || 'never',
      sandbox: options.sandbox || 'workspace-write',
      ...(Object.keys(config).length ? { config } : {}),
      ...(options.additionalDirectories?.length ? { runtimeWorkspaceRoots: options.additionalDirectories } : {}),
    };
    const started = record(options.resumeId
      ? await rpc.request('thread/resume', { threadId: options.resumeId, ...params })
      : await rpc.request('thread/start', params));
    const thread = record(started.thread);
    threadId = typeof thread.id === 'string' ? thread.id : typeof started.threadId === 'string' ? started.threadId : options.resumeId ?? '';
    instructionSources = Array.isArray(started.instructionSources) ? started.instructionSources.filter((item): item is string => typeof item === 'string') : [];
    replay.push(...messagesFrom(started));
    if (!threadId) throw new Error('Codex App Server did not return a thread id.');
    identify('Codex');
  } catch (error) {
    await rpc.dispose();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes('ENOENT') || message.includes('exited') ? `Codex App Server を起動できません。 ${message}` : message);
  }

  async function waitTurn(id: string, signal: AbortSignal): Promise<void> {
    const existing = finished.get(id);
    if (existing === null) return;
    if (existing) throw existing;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        void rpc.request('turn/interrupt', { threadId, turnId: id }).catch(() => undefined);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      waiter = {
        id,
        resolve: () => { signal.removeEventListener('abort', abort); resolve(); },
        reject: (error) => { signal.removeEventListener('abort', abort); reject(error); },
      };
      const raced = finished.get(id);
      if (raced === null) waiter.resolve();
      else if (raced) waiter.reject(raced);
    });
  }

  async function startTurn(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    const response = record(await rpc.request(method, params, signal));
    const turn = record(response.turn);
    turnId = typeof turn.id === 'string' ? turn.id : typeof response.turnId === 'string' ? response.turnId : '';
    if (!turnId) return;
    await waitTurn(turnId, signal);
  }

  return {
    sessionId: threadId,
    async setMode(next) { mode = next; },
    async steer(text) {
      if (!turnId) return false;
      await rpc.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      return true;
    },
    async loadTranscript(emit) {
      for (const message of replay) emit(message);
    },
    async listSessions() {
      const listed = record(await rpc.request('thread/list', { cwd: options.cwd, limit: 30, sortKey: 'updated_at', sortDirection: 'desc' }));
      const threads = Array.isArray(listed.data) ? listed.data : Array.isArray(listed.threads) ? listed.threads : [];
      return threads.flatMap((item): SessionSummary[] => {
        const thread = record(record(item).thread ?? item);
        const id = typeof thread.id === 'string' ? thread.id : '';
        if (!id) return [];
        return [{
          id,
          title: typeof thread.title === 'string' && thread.title ? thread.title : typeof thread.preview === 'string' ? thread.preview : id,
          updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : '',
          provider: 'codex',
          cwd: options.cwd,
        }];
      });
    },
    async fork() {
      const forked = record(await rpc.request('thread/fork', { threadId }));
      const id = typeof record(forked.thread).id === 'string' ? String(record(forked.thread).id) : undefined;
      return id;
    },
    async compact() { await rpc.request('thread/compact/start', { threadId }); },
    async review(target, emit, signal) {
      emitLive.current = emit;
      try {
        await startTurn('review/start', {
          threadId,
          target: target === 'base' ? { type: 'baseBranch', branch: 'main' } : { type: 'uncommittedChanges' },
          delivery: 'inline',
        }, signal);
      } finally {
        emitLive.current = undefined;
      }
    },
    async rateLimits() {
      const limits = record(await rpc.request('account/rateLimits/read', {}));
      const snapshot = record(limits.rateLimits);
      const primary = record(snapshot.primary);
      if (typeof primary.usedPercent === 'number') return `Codex ${primary.usedPercent}% of the current window`;
      return 'Codex rate limits are unavailable.';
    },
    async instructions() {
      const skills = record(await rpc.request('skills/list', { cwds: [options.cwd] }).catch(() => ({})));
      const mcp = record(await rpc.request('mcpServerStatus/list', {}).catch(() => ({})));
      const skillNames = Array.isArray(skills.data) ? skills.data.flatMap((item) => {
        const name = record(item).name;
        return typeof name === 'string' ? [name] : [];
      }) : [];
      const servers = Array.isArray(mcp.data) ? mcp.data.flatMap((item) => {
        const name = record(item).name;
        return typeof name === 'string' ? [name] : [];
      }) : [];
      return [
        instructionSources.length ? `AGENTS.md: ${instructionSources.join(', ')}` : 'AGENTS.md: none reported',
        `Skills: ${skillNames.join(', ') || 'none'}`,
        `MCP: ${servers.join(', ') || 'none'}`,
      ].join('\n');
    },
    async run(prompt, signal, emit, extras) {
      emitLive.current = emit;
      const imagePaths = await writeImageFiles(extras?.images ?? []);
      const input = [
        { type: 'text', text: prompt, text_elements: [] },
        ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ];
      try {
        await startTurn('turn/start', {
          threadId,
          input,
          ...(mode === 'plan' ? { collaborationMode: { mode: 'plan', settings: { model: options.model || '', reasoning_effort: effort ?? null, developer_instructions: null } } } : {}),
        }, signal);
        identify(prompt.slice(0, 80) || 'Codex');
      } finally {
        emitLive.current = undefined;
      }
    },
    async dispose() { await rpc.dispose(); },
  };
}
