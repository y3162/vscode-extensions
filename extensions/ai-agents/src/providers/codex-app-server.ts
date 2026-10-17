import { countUnifiedDiff, normalizeChangeKind, parseUnifiedDiff, previousTextFromDiff } from '../diff-stats.js';
import { writeImageFiles } from '../images.js';
import { captureGitBaselines } from '../change-tracker.js';
import { extensionVersion } from '../version.js';
import type {
  AgentSession, AgentUpdate, ChatMessage, FileChange, PermissionDecision, SessionSummary, SubagentRecord, TerminalRecord, TodoEntry, UsageStats,
} from '../types.js';
import { codexSpawn } from './codex-binary.js';
import type { SessionOptions } from './session-options.js';
import { StdioJsonRpc } from './stdio-rpc.js';
import { describedTool } from './tools.js';
import { errorMessage } from '../types.js';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  const item = record(value);
  if (typeof item.text === 'string') return item.text;
  if ('content' in item) return textOf(item.content);
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
  const source = record(usage.total ?? usage.last ?? usage);
  const input = source.inputTokens ?? source.input_tokens;
  const output = source.outputTokens ?? source.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    scope: usage.total ? 'session' : 'request', source: 'codex-app-server', inputIncludesCache: true,
    contextWindow: typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : undefined,
    contextTokens: typeof record(usage.last).totalTokens === 'number' ? Number(record(usage.last).totalTokens) : undefined,
    cacheWriteInputTokens: typeof source.cacheWriteInputTokens === 'number' ? source.cacheWriteInputTokens : undefined,
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
    const normalized = normalizeChangeKind(entry.kind);
    const diff = typeof entry.diff === 'string' ? entry.diff : undefined;
    const counts = diff ? countUnifiedDiff(diff) : undefined;
    const previousText = diff ? previousTextFromDiff(diff, normalized.kind) : undefined;
    return [{
      path: normalized.movePath ?? filePath,
      kind: normalized.kind,
      ...(normalized.movePath ? { oldPath: filePath } : normalized.oldPath ? { oldPath: normalized.oldPath } : {}),
      ...(diff ? { diff } : {}),
      ...(previousText !== undefined ? { previousText } : {}),
      ...(counts && (counts.additions || counts.deletions) ? { additions: counts.additions, deletions: counts.deletions } : {}),
    }];
  });
}

function turnIdOf(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.turnId === 'string' && body.turnId) return body.turnId;
  const turn = record(body.turn);
  return typeof turn.id === 'string' && turn.id ? turn.id : fallback;
}

function failureText(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = record(value);
  return typeof item.message === 'string' ? item.message : '';
}

function namesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    if (typeof entry.name === 'string') return [entry.name];
    return namesFrom(entry.skills);
  });
}

function normalizedType(type: string): string {
  return type.toLowerCase().replace(/[_-]/g, '');
}

function isSubagentType(type: string): boolean {
  const normalized = normalizedType(type);
  return normalized.includes('collab') || normalized === 'subagentactivity' || normalized === 'spawnagent' || normalized === 'waitagent';
}

function isAgentMessage(type: string): boolean {
  return normalizedType(type).includes('agentmessage');
}

function subagentStatus(statusText: string): SubagentRecord['status'] {
  if (/cancel|interrupt|shutdown/i.test(statusText)) return 'cancelled';
  if (/fail|error/i.test(statusText)) return 'error';
  if (/progress|running|pending|start/i.test(statusText)) return 'running';
  if (/complete|success|done/i.test(statusText)) return 'completed';
  return 'unknown';
}

function threadIdsIn(value: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['newThreadId', 'receiverThreadId', 'childThreadId', 'agentThreadId']) {
    const id = value[key];
    if (typeof id === 'string' && id) ids.push(id);
  }
  if (Array.isArray(value.receiverThreadIds)) ids.push(...value.receiverThreadIds.filter((id): id is string => typeof id === 'string'));
  ids.push(...Object.keys(record(value.agentsStates)));
  return ids;
}

function sameAgentPath(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
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
      if (isSubagentType(type)) {
        for (const id of threadIdsIn(item)) {
          const childState = record(record(item.agentsStates)[id]);
          const child: SubagentRecord = { id, name: typeof item.agentPath === 'string' ? item.agentPath : 'Subagent', status: subagentStatus(String(childState.status ?? item.kind ?? '')), background: 'unknown', ...(typeof item.model === 'string' ? { model: item.model } : {}), ...(typeof childState.message === 'string' ? { resultPreview: childState.message.slice(0, 500) } : {}) };
          const message: ChatMessage = { id: `subagent:${id}`, role: 'status', text: child.name, meta: { type: 'subagent', subagent: child } };
          const index = messages.findIndex((entry) => entry.id === message.id);
          if (index < 0) messages.push(message);
          else messages[index] = message;
        }
        continue;
      }
      const text = textOf(item);
      if (!text) continue;
      const role = type.toLowerCase().includes('user') ? 'user'
        : type.toLowerCase().includes('error') ? 'error'
          : type.toLowerCase().includes('agent') || type.toLowerCase().includes('message') ? 'assistant' : 'tool';
      const backendTurnId = String(record(turn).id ?? '');
      const backendId = typeof item.id === 'string' ? item.id : `history-${messages.length}`;
      messages.push({ id: `${backendTurnId}:${backendId}`, backendTurnId, backendId, role, text });
    }
  }
  return messages;
}

export async function createCodexAppServerSession(options: SessionOptions): Promise<AgentSession> {
  const canonicalCwd = await realpath(options.cwd).catch(() => path.resolve(options.cwd));
  const workspacePath = (name: string): string => {
    const resolved = path.resolve(options.cwd, name);
    const relative = path.relative(canonicalCwd, resolved);
    return !relative.startsWith('..') && !path.isAbsolute(relative) ? path.resolve(options.cwd, relative) : resolved;
  };
  const key = options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  const rpc = new StdioJsonRpc(codexSpawn(options.codexPath, ['app-server', '--listen', 'stdio://'], options.cwd, key));
  let threadId = options.resumeId ?? '';
  let threadModel = options.model || '';
  let turnId = '';
  let mode = options.mode ?? 'agent';
  const childThreads = new Set<string>();
  const children = new Map<string, SubagentRecord>();
  const childText = new Map<string, string>();
  const buffers = new Map<string, string>();
  const agentTexts = new Map<string, string>();
  const turnFilePaths = new Set<string>();
  const turnRenames = new Map<string, FileChange>();
  let sawStructuredPlan = false;
  const finished = new Map<string, Error | null>();
  let stopRequested = false;
  let waiter: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  const replay = messagesFrom({});
  let instructionSources: string[] = [];
  const emitLive = { current: undefined as ((update: AgentUpdate) => void) | undefined };
  const backgroundListeners = new Set<(update: AgentUpdate) => void>();
  const commands = new Map<string, TerminalRecord>();
  let terminals: TerminalRecord[] = [];
  let terminalListError: string | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const effort = options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value;

  function emitBackground(update: AgentUpdate): void {
    if (disposed) return;
    if (backgroundListeners.size) for (const listener of backgroundListeners) listener(update);
    else emitLive.current?.(update);
  }

  function updateChild(id: string, patch: Partial<SubagentRecord>): void {
    if (!id || id === threadId) return;
    childThreads.add(id);
    const child: SubagentRecord = { id, name: 'Subagent', status: 'unknown', background: 'unknown', ...children.get(id), ...patch };
    children.set(id, child);
    emitBackground({ id: `subagent:${id}`, role: 'status', text: child.task || child.name, meta: { type: 'subagent', subagent: child } });
  }

  function publishTerminals(): void {
    emitBackground({ id: 'terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: terminals.map((item) => ({ ...item })), terminalError: terminalListError } });
  }

  function schedulePoll(): void {
    if (disposed || rpc.isClosed || pollTimer || (!terminals.length && ![...children.values()].some((child) => child.status === 'running' || child.status === 'unknown'))) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void (async () => {
        if (terminals.length || terminalListError) await refreshTerminals().catch(terminalError);
        if (!emitLive.current) {
          await Promise.all([...children].filter(([, child]) => child.status === 'running' || child.status === 'unknown').map(async ([id, child]) => {
            try {
              const read = record(await rpc.request('thread/read', { threadId: id, includeTurns: true }, AbortSignal.timeout(10000)));
              const thread = record(read.thread);
              const turns = Array.isArray(thread.turns) ? thread.turns : [];
              const last = record(turns.at(-1));
              const status = subagentStatus(String(last.status ?? ''));
              if (['completed', 'error', 'cancelled'].includes(status) && record(thread.status).type !== 'active') {
                const items = Array.isArray(last.items) ? last.items : [];
                const preview = items.map(record).filter((item) => isAgentMessage(itemType(item))).map(textOf).join('\n');
                updateChild(id, { status, endedAt: Date.now(), ...(preview ? { resultPreview: preview.slice(0, 500) } : {}) });
              }
            } catch {
              if (child.status !== 'unknown') updateChild(id, { status: 'unknown' });
            }
          }));
        }
      })().finally(schedulePoll);
    }, 2000);
    pollTimer.unref();
  }

  function terminalError(error: unknown): void {
    terminalListError = errorMessage(error);
    terminals = terminals.map((item) => ({ ...item, status: 'unknown', error: terminalListError }));
    publishTerminals();
  }

  async function refreshTerminals(): Promise<TerminalRecord[]> {
    const rows: TerminalRecord[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = record(await rpc.request('thread/backgroundTerminals/list', { threadId, limit: 20, ...(cursor ? { cursor } : {}) }, AbortSignal.timeout(10000)));
      const data = Array.isArray(listed.data) ? listed.data : Array.isArray(listed.terminals) ? listed.terminals : undefined;
      if (!data) throw new Error('Background terminal list did not contain an array.');
      for (const raw of data) {
        const entry = record(raw);
        const processId = String(entry.processId ?? entry.id ?? '');
        if (!processId) continue;
        const itemId = typeof entry.itemId === 'string' ? entry.itemId : undefined;
        const saved = itemId ? commands.get(itemId) : undefined;
        if (saved?.status && /complete|fail|cancel|interrupt/i.test(saved.status)) continue;
        rows.push({ ...saved, processId, ...(itemId ? { itemId } : {}), ...(typeof entry.command === 'string' ? { command: entry.command } : {}), status: 'running', error: undefined });
      }
      cursor = typeof listed.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Background terminal list repeated a cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (disposed) return [];
    terminals = rows;
    terminalListError = undefined;
    publishTerminals();
    if (!rows.length && pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
    schedulePoll();
    return rows;
  }

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
    const destination = emitLive.current ?? emitBackground;
    const emit = (update: AgentUpdate) => destination({ ...update, backendTurnId: turnId });
    const type = itemType(item).toLowerCase();
    const id = typeof item.id === 'string' ? item.id : type || 'item';
    const text = textOf(item) || buffers.get(id) || '';
    if (type.includes('command')) {
      const saved = commands.get(id);
      const processId = typeof item.processId === 'string' ? item.processId : saved?.processId;
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : buffers.get(id) ?? saved?.output;
      const status = typeof item.status === 'string' ? item.status : saved?.status ?? 'unknown';
      if (processId) {
        const command: TerminalRecord = { ...saved, processId, itemId: id, status, ...(typeof item.command === 'string' ? { command: item.command } : {}), ...(output !== undefined ? { output } : {}), ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}) };
        commands.set(id, command);
        const active = terminals.findIndex((row) => row.processId === processId);
        if (active >= 0) {
          if (/complete|fail|cancel|interrupt/i.test(status)) terminals.splice(active, 1);
          else terminals[active] = { ...terminals[active], ...command };
        }
        emitBackground({ id, role: 'tool', text: [command.command, command.output].filter(Boolean).join('\n'), tool: { ...describedTool('shell', command.command ?? '', status), ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}) } });
        if (active >= 0) publishTerminals();
        return;
      }
      emit({ id, role: 'tool', text: [typeof item.command === 'string' ? item.command : '', output].filter(Boolean).join('\n'), tool: { ...describedTool('shell', typeof item.command === 'string' ? item.command : '', status), ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}) } });
      return;
    }
    if (type.includes('file')) {
      const files = /progress|pending|fail|declin|cancel|interrupt/i.test(String(item.status ?? '')) ? [] : filesOf(item).map((file) => ({ ...file, path: workspacePath(file.path), ...(file.oldPath ? { oldPath: workspacePath(file.oldPath) } : {}) }));
      for (const file of files) if (file.kind === 'rename') turnRenames.set(file.path, file);
      for (const file of files) turnFilePaths.add(file.path);
      const body = text || files.map((file) => `${file.kind}: ${file.path}`).join('\n');
      emit({
        id, role: 'tool', text: body, tool: describedTool('edit', body, typeof item.status === 'string' ? item.status : 'completed'),
        ...(files.length ? { meta: { type: 'files', files } } : {}),
      });
      return;
    }
    if (type === 'plan') {
      sawStructuredPlan = true;
      if (text) emit({ id, role: 'status', text, meta: { type: 'plan', plan: { markdown: text, source: 'app-server-plan' } } });
      return;
    }
    if (type.includes('todo')) {
      const todos = todosOf(item.items ?? item.todos ?? item.plan);
      emit({ id, role: 'status', text: text || todos.map((todo) => `${todo.status}: ${todo.content}`).join('\n'), ...(todos.length ? { meta: { type: 'todo', todos } } : {}) });
      return;
    }
    if (isSubagentType(type)) {
      const activity = normalizedType(type) === 'subagentactivity';
      for (const child of threadIdsIn(item)) {
        const state = record(record(item.agentsStates)[child]);
        const statusText = typeof state.status === 'string' ? state.status : activity ? String(item.kind ?? '')
          : /spawn/i.test(String(item.tool ?? type)) ? 'pendingInit' : '';
        const previous = children.get(child);
        const status = activity && item.kind === 'completed' && previous && ['error', 'cancelled'].includes(previous.status) ? previous.status : subagentStatus(statusText);
        updateChild(child, {
          status,
          ...(typeof item.agentPath === 'string' ? { name: item.agentPath } : {}),
          ...(typeof item.model === 'string' ? { model: item.model } : {}),
          ...(typeof item.prompt === 'string' ? { task: item.prompt } : {}),
          ...(typeof state.message === 'string' ? { resultPreview: state.message.slice(0, 500) } : {}),
          ...(status === 'running' && !previous?.startedAt ? { startedAt: Date.now() } : {}),
          ...(['completed', 'error', 'cancelled'].includes(status) ? { endedAt: Date.now() } : {}),
        });
      }
      return;
    }
    if (type.includes('reasoning') || isAgentMessage(type)) {
      const phase = typeof item.phase === 'string' ? item.phase : '';
      if (isAgentMessage(type) && text) agentTexts.set(id, text);
      if (text) emit({
        id, role: type.includes('reasoning') ? 'status' : 'assistant', text,
        ...(phase === 'final_answer' ? { final: true } : {}),
        ...(type.includes('reasoning') ? { meta: { type: 'thinking' as const } } : {}),
      });
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
    closed: (error) => {
      waiter?.reject(error);
      waiter = null;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
      terminalError(error);
      for (const [id, child] of children) if (child.status === 'running') updateChild(id, { status: 'unknown' });
    },
    notification: (method, params) => {
      const body = record(params);
      const item = record(body.item);
      const noted = typeof body.threadId === 'string' ? body.threadId : '';
      if (noted && threadId && noted !== threadId && !childThreads.has(noted)) return;
      if (noted && childThreads.has(noted)) {
        if (isSubagentType(itemType(item))) emitItem(item);
        const turn = record(body.turn);
        const status = method === 'turn/completed' ? subagentStatus(String(turn.status ?? '')) : method === 'turn/started' ? 'running' : children.get(noted)?.status ?? 'unknown';
        const piece = isAgentMessage(itemType(item)) ? textOf(item) : method === 'item/agentMessage/delta' && typeof body.delta === 'string' ? body.delta : '';
        if (piece && method.includes('delta')) childText.set(noted, `${childText.get(noted) ?? ''}${piece}`);
        else if (piece) childText.set(noted, piece);
        const preview = childText.get(noted) ?? '';
        updateChild(noted, { status, ...(preview ? { resultPreview: preview.slice(0, 500) } : {}), ...(method === 'turn/completed' ? { endedAt: Date.now(), ...(typeof turn.durationMs === 'number' ? { durationMs: turn.durationMs } : {}) } : {}) });
        const childType = itemType(item).toLowerCase();
        if (childType.includes('file')) {
          const files = filesOf(item);
          for (const file of files) turnFilePaths.add(file.path);
          if (files.length) emitBackground({ id: `${noted}:files`, role: 'tool', text: 'diff updated', meta: { type: 'files', files } });
        }
        return;
      }
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
      if (method === 'turn/started') {
        const id = turnIdOf(body, '');
        if (id) turnId = id;
        if (stopRequested && id) void rpc.request('turn/interrupt', { threadId, turnId: id }).catch(() => undefined);
      }
      if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') emitItem(item);
      if (method === 'turn/completed' || method === 'turn/diff/updated') {
        const id = turnIdOf(body, turnId);
        if (typeof body.diff === 'string' && emitLive.current) {
          const parsed = parseUnifiedDiff(body.diff).map((file) => {
            const previousText = previousTextFromDiff(file.diff, file.kind);
            return {
              path: file.path,
              kind: file.kind,
              diff: file.diff,
              additions: file.additions,
              deletions: file.deletions,
              ...(file.oldPath ? { oldPath: file.oldPath } : {}),
              ...(previousText !== undefined ? { previousText } : {}),
            };
          });
          const files = turnFilePaths.size
            ? parsed.filter((file) => [...turnFilePaths].some((item) => sameAgentPath(item, file.path)))
            : parsed;
          if (files.length) emitLive.current({ id: `${id}:diff`, role: 'tool', text: 'diff updated', meta: { type: 'files', files } });
        }
        const turn = record(body.turn);
        const usage = usageOf(body.usage ?? body.tokenUsage ?? turn.usage);
        if (usage && emitLive.current) emitLive.current({ id: `${id}:usage`, role: 'status', text: '', meta: { type: 'usage', usage } });
        if (method === 'turn/completed') {
          const status = typeof turn.status === 'string' ? turn.status : 'completed';
          const message = failureText(turn.error) || failureText(body.error);
          finish(id, status === 'failed' ? new Error(message || 'Codex turn failed.') : /interrupt|cancel/i.test(status) ? new DOMException('Cancelled', 'AbortError') : null);
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = usageOf(body.tokenUsage ?? body);
        if (usage && emitLive.current) emitLive.current({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage } });
      }
      if (method === 'turn/plan/updated') {
        const todos = todosOf(body.plan);
        emitLive.current?.({ id: 'plan', role: 'status', text: typeof body.explanation === 'string' ? body.explanation : '', meta: { type: 'todo', todos } });
      }
      if (method === 'error') {
        const message = failureText(body.error) || failureText(body) || 'Codex app-server error';
        if (body.willRetry === true) return;
        finish(turnIdOf(body, turnId), new Error(message));
      }
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
      clientInfo: { name: 'ai_agents_vscode', title: 'AI Agents', version: extensionVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, options.signal);
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
      ? await rpc.request('thread/resume', { threadId: options.resumeId, ...params }, options.signal)
      : await rpc.request('thread/start', params, options.signal));
    const thread = record(started.thread);
    threadId = typeof thread.id === 'string' ? thread.id : typeof started.threadId === 'string' ? started.threadId : options.resumeId ?? '';
    const reportedModel = typeof thread.model === 'string' ? thread.model : typeof started.model === 'string' ? started.model : '';
    if (reportedModel) threadModel = reportedModel;
    instructionSources = Array.isArray(started.instructionSources) ? started.instructionSources.filter((item): item is string => typeof item === 'string') : [];
    replay.push(...messagesFrom(started));
    for (const message of replay) if (message.meta?.subagent) {
      children.set(message.meta.subagent.id, message.meta.subagent);
      childThreads.add(message.meta.subagent.id);
    }
    if (!threadId) throw new Error('Codex App Server did not return a thread id.');
    identify('Codex');
  } catch (error) {
    await rpc.dispose();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes('ENOENT') || message.includes('exited') ? `Codex App Server を起動できません。 ${message}` : message);
  }

  async function waitTurn(id: string, signal: AbortSignal): Promise<void> {
    const existing = finished.get(id);
    if (existing === null) return;
    if (existing) throw existing;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        stopRequested = true;
        if (id) void rpc.request('turn/interrupt', { threadId, turnId: id }).catch(() => undefined);
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
    stopRequested = signal.aborted;
    const response = record(await rpc.request(method, params, signal));
    turnId = turnIdOf(response, turnId);
    if (!turnId) return;
    if (signal.aborted) {
      void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      throw new DOMException('Cancelled', 'AbortError');
    }
    await waitTurn(turnId, signal);
  }

  return {
    sessionId: threadId,
    subscribeBackgroundUpdates(emit) {
      backgroundListeners.add(emit);
      schedulePoll();
      return () => backgroundListeners.delete(emit);
    },
    get closed() { return rpc.isClosed; },
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
      let cursor: string | undefined;
      const turns: unknown[] = [];
      try {
        do {
          const page = record(await rpc.request('thread/turns/list', { threadId, limit: 50, itemsView: 'full', sortDirection: 'asc', ...(cursor ? { cursor } : {}) }));
          if (Array.isArray(page.data)) turns.push(...page.data);
          else if (replay.length) { for (const message of replay) emit(message); return; }
          cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        } while (cursor);
        for (const message of messagesFrom({ turns })) emit(message);
      } catch (error) {
        if (replay.length) { for (const message of replay) emit(message); }
        else {
          const read = await rpc.request('thread/read', { threadId, includeTurns: true });
          for (const message of messagesFrom(read)) emit(message);
        }
      }
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
        schedulePoll();
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
      const skillNames = namesFrom(skills.data);
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
    async listBackgroundTerminals() {
      try { return await refreshTerminals(); }
      catch (error) { terminalError(error); throw error; }
    },
    async terminateBackgroundTerminal(processId: string) {
      const result = record(await rpc.request('thread/backgroundTerminals/terminate', { threadId, processId }));
      await refreshTerminals();
      if (result.terminated !== true && terminals.some((item) => item.processId === processId)) throw new Error('Background terminal was not terminated.');
    },
    async interruptBackgroundTerminal(processId: string) {
      // Agent-owned executions have no public stdin/PTY attachment endpoint.
      // Use their owning runtime's cancellation, never signal an inferred OS PID.
      const current = (await refreshTerminals()).find((item) => item.processId === processId);
      if (!current) throw new Error('このバックグラウンドターミナルは終了しています。');
      const result = record(await rpc.request('thread/backgroundTerminals/terminate', { threadId, processId }));
      await refreshTerminals();
      if (result.terminated !== true && terminals.some((item) => item.processId === processId)) throw new Error('Background terminal was not interrupted.');
    },
    async run(prompt, signal, emit, extras, turn) {
      emitLive.current = emit;
      agentTexts.clear();
      turnFilePaths.clear();
      turnRenames.clear();
      sawStructuredPlan = false;
      const imagePaths = await writeImageFiles(extras?.images ?? []);
      const input = [
        { type: 'text', text: prompt, text_elements: [] },
        ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ];
      const model = turn?.selection.model || options.model || threadModel;
      const turnEffort = turn?.selection.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value ?? effort;
      const turnMode = turn?.mode ?? mode;
      mode = turnMode;
      const baselines = await captureGitBaselines(options.cwd);
      try {
        await startTurn('turn/start', {
          threadId,
          input,
          ...(model ? { model } : {}),
          ...(turnEffort ? { effort: turnEffort } : {}),
          collaborationMode: {
            mode: turnMode === 'plan' ? 'plan' : 'default',
            settings: { model: model || null, reasoning_effort: turnEffort ?? null, developer_instructions: null },
          },
        }, signal);
        if (turnMode === 'plan' && !sawStructuredPlan && !signal.aborted) {
          const planText = [...agentTexts.values()].map((item) => item.trim()).filter(Boolean).join('\n\n');
          if (planText) emit({ id: 'plan-text', role: 'status', text: planText, meta: { type: 'plan', plan: { markdown: planText, source: 'assistant-text' } } });
        }
        identify(prompt.slice(0, 80) || 'Codex');
      } finally {
        let changes = await baselines?.changes();
        for (const file of turnRenames.values()) {
          const previous = file.oldPath ? await baselines?.lookup(file.oldPath) : undefined;
          const moved = [file.path, file.oldPath].filter((name): name is string => Boolean(name)).map((name) => path.resolve(options.cwd, name));
          changes = (changes ?? []).filter((change) => !moved.includes(path.resolve(options.cwd, change.path)));
          changes.push({ ...file, ...(previous !== undefined ? { previousText: previous } : {}) });
        }
        if (changes?.length) emitBackground({ id: `workspace-changes:${turnId}`, role: 'tool', text: 'diff updated', meta: { type: 'files', files: changes } });
        if (!disposed && !rpc.isClosed) await refreshTerminals().catch(terminalError);
        emitLive.current = undefined;
        schedulePoll();
      }
    },
    async dispose() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      backgroundListeners.clear();
      waiter?.reject(new Error('Agent process closed.'));
      waiter = null;
      await rpc.dispose();
    },
  };
}
