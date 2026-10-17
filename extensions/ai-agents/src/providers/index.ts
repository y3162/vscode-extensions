import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Run, ConversationTurn } from '@cursor/sdk';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { applyTextStats, captureGitBaselines, readWorkspaceText, type GitBaselines } from '../change-tracker.js';
import { captureBaseline } from '../change-review.js';
import { writeImageFiles } from '../images.js';
import type { AgentSession, AgentUpdate, FileChange, Selection, SessionSummary, TurnOptions, UpdateMeta } from '../types.js';
import { createCodexAppServerSession } from './codex-app-server.js';
import { cursorStoredMessages } from './cursor-history.js';
import { loadCursorSdk, loadPublishedCursorSdk } from './cursor-sdk.js';
import { cursorBackgroundRuntime, type CursorBackgroundRuntime } from './cursor-background-runtime.js';
import { CursorTerminals } from './cursor-terminals.js';
import { createCursorWorker } from './cursor-worker-client.js';
import { createCursorAcpSession } from './cursor-acp.js';
import { codexMeta, codexUsage, cursorMeta } from './details.js';
import { codexUpdate, cursorUpdate } from './events.js';
import { AssistantSegments } from './segments.js';
import { mergeStreamText } from './stream-text.js';
import { codexTool, cursorTool } from './tools.js';
import type { SessionOptions } from './session-options.js';

export type { SessionOptions } from './session-options.js';

export function cursorNodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 22 || major === 22 && minor >= 13;
}

/** Routes an already-verified terminal identity to the worker's SDK runtime, if one is installed. */
export function interruptCursorBackgroundShell(shellId: number, pid: number, runtime?: CursorBackgroundRuntime | null): boolean {
  const owner = runtime === undefined ? cursorBackgroundRuntime() : runtime;
  return owner?.interrupt(shellId, pid) ?? false;
}

interface SessionDependencies {
  nodeVersion?: string;
  writeImages?: typeof writeImageFiles;
}

export function loadCodexSdk(): Promise<typeof import('@openai/codex-sdk')> {
  return import('@openai/codex-sdk');
}

export function loadCursorSdkForSession(): Promise<typeof import('@cursor/sdk')> {
  return loadCursorSdk();
}

const sdkLoaders = {
  codex: loadCodexSdk,
  cursor: loadCursorSdkForSession,
};

function cursorToolPath(meta: ReturnType<typeof cursorMeta>): string | undefined {
  const file = meta?.type === 'files' ? meta.files?.[0]?.path : undefined;
  return file && file !== 'patch' ? file : undefined;
}

export async function createSession(options: SessionOptions, loaders = sdkLoaders, inProcess = false, dependencies: SessionDependencies = {}): Promise<AgentSession> {
  if (options.provider === 'codex' && options.backend === 'app-server') return createCodexAppServerSession(options);
  if (options.provider === 'cursor' && options.backend === 'acp') return createCursorAcpSession(options);
  if (options.provider === 'cursor' && loaders === sdkLoaders && !inProcess) return createCursorWorker(options);
  if (options.provider === 'codex') {
    if (options.approval && options.approval !== 'never') {
      throw new Error('この承認ポリシーは対話操作が必要です。バックエンドを Codex App Server に切り替えてください。');
    }
    const { Codex } = await loaders.codex();
    const codex = new Codex({
      apiKey: options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
      codexPathOverride: options.codexPath || undefined,
    });
    const sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' = options.sandbox === 'read-only' || options.sandbox === 'danger-full-access'
      ? options.sandbox : 'workspace-write';
    let threadModel = options.model || undefined;
    let threadEffort = options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value as ModelReasoningEffort | undefined;
    const threadOptions = () => ({
      workingDirectory: options.cwd,
      model: threadModel,
      modelReasoningEffort: threadEffort,
      sandboxMode,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      ...(options.network ? { networkAccessEnabled: true } : {}),
      ...(options.webSearch ? { webSearchMode: options.webSearch as 'disabled' | 'cached' | 'live' } : {}),
      ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
    });
    let thread = options.resumeId
      ? codex.resumeThread(options.resumeId, threadOptions())
      : codex.startThread(threadOptions());
    const backgroundListeners = new Set<(update: AgentUpdate) => void>();
    const retarget = (selection?: Selection) => {
      if (!selection) return;
      const model = selection.model || undefined;
      const effort = selection.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value as ModelReasoningEffort | undefined;
      if (model === threadModel && effort === threadEffort) return;
      threadModel = model;
      threadEffort = effort;
      thread = thread.id ? codex.resumeThread(thread.id, threadOptions()) : codex.startThread(threadOptions());
    };
    return {
      get sessionId() { return thread.id ?? undefined; },
      subscribeBackgroundUpdates(emit) { backgroundListeners.add(emit); return () => backgroundListeners.delete(emit); },
      setModel(selection) { retarget(selection); },
      async run(prompt, signal, emit, extras, turn) {
        signal.throwIfAborted();
        retarget(turn?.selection);
        const images = await (dependencies.writeImages ?? writeImageFiles)(extras?.images ?? []);
        const input = images.length
          ? [{ type: 'text' as const, text: prompt }, ...images.map((imagePath) => ({ type: 'local_image' as const, path: imagePath }))]
          : prompt;
        const baselines = await captureGitBaselines(options.cwd);
        try {
          const { events } = await thread.runStreamed(input, { signal });
          for await (const event of events) {
            signal.throwIfAborted();
            if (event.type === 'thread.started') {
              options.onIdentity?.({ id: event.thread_id, title: prompt.slice(0, 80) || 'Codex', updatedAt: new Date().toISOString(), provider: 'codex', cwd: options.cwd });
            }
            if (event.type === 'turn.completed') {
              emit({ id: `usage-${event.type}`, role: 'status', text: '', meta: { type: 'usage', usage: {
                ...codexUsage(event.usage), scope: 'session', source: 'codex-sdk', inputIncludesCache: true,
              } } });
            }
            if (event.type === 'turn.failed') throw new Error(event.error.message);
            if (event.type === 'error') throw new Error(event.message);
            if ('item' in event) {
              const update = codexUpdate(event.item);
              const meta = await enrichCodexFiles(codexMeta(event.item), baselines, options.cwd);
              const tool = codexTool(event.item);
              if (update) emit({ ...update, ...(meta ? { meta } : {}), ...(tool ? { tool } : {}) });
            }
          }
        } finally {
          const changes = await baselines?.changes();
          if (changes?.length) {
            const update: AgentUpdate = { id: `workspace-changes:${randomUUID()}`, role: 'tool', text: 'diff updated', meta: { type: 'files', files: changes } };
            if (backgroundListeners.size) for (const listener of backgroundListeners) listener(update);
            else emit(update);
          }
        }
      },
      async dispose() { backgroundListeners.clear(); /* The SDK starts a subprocess per turn; AbortSignal stops it. */ },
    };
  }

  if (!cursorNodeVersionSupported(dependencies.nodeVersion ?? process.versions.node)) {
    throw new Error('Cursor SDKにはNode.js 22.13以降が必要です。VS Codeを更新してください。');
  }
  const { Agent, Cursor, JsonlLocalAgentStore } = await loaders.cursor();
  if (!options.apiKey && !process.env.CURSOR_API_KEY) {
    const auth = await Cursor.auth.status();
    if (auth.status !== 'logged-in') {
      throw new Error('Cursor SDKに未ログインです。サイドバーの「ログイン」または「APIキー」から認証してください。');
    }
  }
  await mkdir(options.storagePath, { recursive: true });
  const store = new JsonlLocalAgentStore(options.storagePath);
  const local = {
    cwd: options.cwd,
    store,
    sandboxOptions: { enabled: options.sandbox !== 'disabled' },
    settingSources: ['project', 'user'] as ('project' | 'user')[],
    ...(options.additionalDirectories?.length ? { dirs: options.additionalDirectories } : {}),
  };
  let activeModel = { id: options.model || 'auto', ...(options.modelParams?.length ? { params: options.modelParams } : {}) };
  const mode = options.mode === 'plan' ? 'plan' as const : 'agent' as const;
  const agent = options.resumeId
    ? await Agent.resume(options.resumeId, { apiKey: options.apiKey || undefined, model: activeModel, mode, local })
    : await Agent.create({
      apiKey: options.apiKey || undefined,
      model: activeModel,
      mode,
      local,
    });
  options.onIdentity?.({
    id: agent.agentId,
    title: 'Cursor',
    updatedAt: new Date().toISOString(),
    provider: 'cursor',
    cwd: options.cwd,
  });
  const baselines = new Map<string, FileChange>();
  const terminalListeners = new Set<(update: AgentUpdate) => void>();
  const terminals = options.cursorTerminalDataDir ? new CursorTerminals(options.cursorTerminalDataDir, (update) => {
    for (const listener of terminalListeners) listener(update);
  }, undefined, options.cwd, interruptCursorBackgroundShell) : undefined;
  let activeMode = mode;
  return {
    sessionId: agent.agentId,
    subscribeBackgroundUpdates(emit) { terminalListeners.add(emit); return () => terminalListeners.delete(emit); },
    async listBackgroundTerminals() { return await terminals?.refresh() ?? []; },
    async interruptBackgroundTerminal(id) {
      if (!terminals) throw new Error('Cursor terminal monitoring is unavailable.');
      await terminals.interrupt(id);
    },
    async terminateBackgroundTerminal(id) {
      if (!terminals) throw new Error('Cursor terminal monitoring is unavailable.');
      await terminals.interrupt(id);
    },
    setModel(selection) {
      activeModel = { id: selection.model || 'auto', ...(selection.modelParams?.length ? { params: selection.modelParams } : {}) };
    },
    async setMode(next) {
      if (next === 'ask') return;
      activeMode = next;
    },
    async loadTranscript(emit) {
      const runs: Run[] = [];
      let cursor: string | undefined;
      do {
        const page = await Agent.listRuns(agent.agentId, { runtime: 'local', cwd: options.cwd, store, cursor, limit: 100 });
        runs.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      const rows: Awaited<ReturnType<typeof Agent.messages.list>> = [];
      for (let offset = 0; ; offset += 100) {
        const page = await Agent.messages.list(agent.agentId, { runtime: 'local', cwd: options.cwd, store, limit: 100, offset });
        rows.push(...page); if (page.length < 100) break;
      }
      const stored = cursorStoredMessages(rows, runs);
      if (stored.length) { for (const message of stored) emit(message); return; }
      for (const run of runs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
        if (run.supports('conversation')) for (const message of conversationMessages(run.id, await run.conversation())) emit(message);
      }
      if (!runs.length) for (const message of rows) {
        const text = transcriptText(message.message);
        if (text) emit({ id: message.uuid, role: message.type === 'user' ? 'user' : 'assistant', text });
      }
    },
    async run(prompt, signal, emit, extras, turn) {
      signal.throwIfAborted();
      const payload = extras?.images?.length
        ? { text: prompt, images: extras.images.map((image) => ({ data: image.data, mimeType: image.mimeType })) }
        : prompt;
      const requested = turn?.mode === 'plan' ? 'plan' : turn?.mode === 'agent' ? 'agent' : activeMode;
      activeMode = requested;
      if (turn?.selection) {
        activeModel = { id: turn.selection.model || 'auto', ...(turn.selection.modelParams?.length ? { params: turn.selection.modelParams } : {}) };
      }
      const segments = new AssistantSegments();
      let sawPlan = false;
      const run = await agent.send(payload, {
        mode: requested,
        model: activeModel,
        onDelta: ({ update }) => {
          if (update.type !== 'tool-call-completed' || update.toolCall.type !== 'createPlan') return;
          const plan = typeof update.toolCall.args.plan === 'string' ? update.toolCall.args.plan : '';
          if (!plan.trim() || signal.aborted) return;
          sawPlan = true;
          emit({ id: `plan-${update.callId}`, role: 'status', text: plan, meta: { type: 'plan', plan: { markdown: plan, source: 'sdk-createPlan' } } });
        },
      });
      terminals?.start();
      const forward = emit;
      emit = (update) => forward({ ...update, backendTurnId: run.id });
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= run.cancel();
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let index = 0;
      let hasAssistant = false;
      let sawUsage = false;
      let thinkingText = '';
      try {
        for await (const event of run.stream()) {
          if (event.type === 'tool_call' && event.status === 'running') {
            const early = cursorMeta(event);
            const filePath = cursorToolPath(early);
            if (filePath) await captureBaseline(options.cwd, filePath, baselines);
          }
          if (event.type === 'thinking' && event.text && !signal.aborted) {
            thinkingText = mergeStreamText(thinkingText, event.text);
            emit({ id: 'thinking', role: 'status', text: thinkingText, meta: { type: 'thinking' } });
            continue;
          }
          if (event.type === 'tool_call') segments.interrupt();
          if (event.type === 'assistant' && !signal.aborted) {
            const chunk = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
            const segment = chunk ? segments.push(chunk) : undefined;
            if (segment) {
              hasAssistant = true;
              emit({ id: segment.id, role: 'assistant', text: segment.text });
            }
            continue;
          }
          if (event.type === 'usage' && !signal.aborted) {
            sawUsage = true;
            const meta = cursorMeta(event);
            if (meta) emit({ id: `usage-${index}`, role: 'status', text: '', meta });
          }
          const update = cursorUpdate(event, index++);
          const meta = await withBaseline(cursorMeta(event), baselines, options.cwd);
          if (meta?.type === 'plan') sawPlan = true;
          const tool = cursorTool(event);
          if (update?.text && !signal.aborted) {
            hasAssistant ||= update.role === 'assistant';
            emit({ ...update, ...(meta ? { meta } : {}), ...(tool ? { tool } : {}) });
          }
          if (event.type === 'request') {
            await run.cancel();
            throw new Error('追加入力が必要なため停止しました。依頼を具体的にして再送してください。');
          }
        }
        const result = await run.wait();
        if (!sawUsage && result.usage) emit({ id: 'usage-result', role: 'status', text: '', meta: { type: 'usage', usage: { ...result.usage, cachedInputTokens: result.usage.cacheReadTokens, cacheWriteInputTokens: result.usage.cacheWriteTokens, scope: 'run', source: 'cursor-sdk', inputIncludesCache: false } } });
        if (result.status === 'error') throw new Error(result.error?.message ?? 'Cursorの実行に失敗しました。');
        if (result.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
        if (!hasAssistant && result.result && !signal.aborted) {
          emit({ id: 'result', role: 'assistant', text: result.result });
        }
        const planText = segments.fullText().trim() || (!hasAssistant ? result.result?.trim() ?? '' : '');
        if (requested === 'plan' && !sawPlan && planText && !signal.aborted) {
          emit({ id: 'plan-text', role: 'status', text: planText, meta: { type: 'plan', plan: { markdown: planText, source: 'assistant-text' } } });
        }
        options.onIdentity?.({ id: agent.agentId, title: prompt.slice(0, 80) || 'Cursor', updatedAt: new Date().toISOString(), provider: 'cursor', cwd: options.cwd });
      } finally {
        signal.removeEventListener('abort', cancel);
        await cancellation;
        await terminals?.finishRun().catch(() => undefined);
      }
    },
    async dispose() { terminals?.dispose(); terminalListeners.clear(); await agent[Symbol.asyncDispose](); },
  };
}

async function withBaseline(meta: ReturnType<typeof cursorMeta>, baselines: Map<string, FileChange>, cwd: string) {
  if (meta?.type !== 'files' || !meta.files) return meta;
  const files: FileChange[] = [];
  for (const file of meta.files) {
    const saved = baselines.get(path.resolve(cwd, file.path));
    if (saved?.previousText === undefined) { files.push(file); continue; }
    const kind: FileChange['kind'] = saved.previousText === null ? 'add' : file.kind === 'delete' ? 'delete' : 'update';
    const current = await readWorkspaceText(cwd, file.path);
    files.push(applyTextStats({ ...file, previousText: saved.previousText, previousMode: saved.previousMode, kind }, current));
  }
  return {
    ...meta,
    files,
  };
}

async function enrichCodexFiles(meta: UpdateMeta | undefined, baselines: GitBaselines | undefined, cwd: string): Promise<UpdateMeta | undefined> {
  if (meta?.type !== 'files' || !meta.files?.length) return meta;
  const files: FileChange[] = [];
  for (const file of meta.files) {
    const baseline = await baselines?.lookup(file.oldPath ?? file.path);
    const previous = baseline !== undefined ? baseline : file.previousText;
    const previousMode = await baselines?.lookupMode(file.oldPath ?? file.path);
    const current = await readWorkspaceText(cwd, file.path);
    files.push(applyTextStats({
      ...file,
      ...(previous !== undefined ? { previousText: previous } : {}),
      ...(previousMode !== undefined ? { previousMode } : {}),
    }, current));
  }
  return { ...meta, files };
}

function transcriptText(message: unknown): string {
  const body = message && typeof message === 'object' && 'content' in message ? message.content : undefined;
  if (!Array.isArray(body)) return '';
  return body.flatMap((block) => block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('');
}

export async function listCursorSdkSessions(
  options: Pick<SessionOptions, 'cwd' | 'storagePath' | 'apiKey'>,
  load: () => Promise<typeof import('@cursor/sdk')> | typeof import('@cursor/sdk') = loadPublishedCursorSdk,
): Promise<SessionSummary[]> {
  const { Agent, JsonlLocalAgentStore } = await load();
  await mkdir(options.storagePath, { recursive: true });
  const listed = await Agent.list({ runtime: 'local', cwd: options.cwd, store: new JsonlLocalAgentStore(options.storagePath) });
  return listed.items.map((item) => ({
    id: item.agentId,
    title: item.name || item.summary || item.agentId,
    updatedAt: new Date(item.lastModified || Date.now()).toISOString(),
    provider: 'cursor' as const,
    cwd: options.cwd,
  }));
}

export async function writeBaselineFile(storagePath: string, change: FileChange): Promise<string> {
  await mkdir(storagePath, { recursive: true });
  const name = `${Buffer.from(change.path).toString('base64url').slice(0, 80)}-${path.basename(change.path)}`;
  const file = path.join(storagePath, name);
  await writeFile(file, change.previousText ?? '', 'utf8');
  return file;
}

function conversationMessages(runId: string, turns: ConversationTurn[]): import('../types.js').ChatMessage[] {
  const messages: import('../types.js').ChatMessage[] = [];
  let assistant = 0;
  for (const [index, entry] of turns.entries()) {
    if (entry.type === 'shellConversationTurn') {
      messages.push({ id: `${runId}:shell-${index}`, backendTurnId: runId, role: 'tool', text: [entry.turn.shellCommand?.command, entry.turn.shellOutput?.stdout, entry.turn.shellOutput?.stderr].filter(Boolean).join('\n') });
      continue;
    }
    if (entry.turn.userMessage) messages.push({ id: `${runId}:user-${index}`, backendTurnId: runId, role: 'user', text: entry.turn.userMessage.text });
    for (const [stepIndex, step] of entry.turn.steps.entries()) {
      if (step.type === 'assistantMessage') {
        const backendId = `assistant-${++assistant}`;
        messages.push({ id: `${runId}:${backendId}`, backendId, backendTurnId: runId, role: 'assistant', text: step.message.text });
      } else if (step.type === 'thinkingMessage') {
        messages.push({ id: `${runId}:thinking-${stepIndex}`, backendTurnId: runId, role: 'status', text: step.message.text, meta: { type: 'thinking' } });
      } else messages.push({ id: `${runId}:tool-${stepIndex}`, backendTurnId: runId, role: 'tool', text: JSON.stringify(step.message, null, 2), tool: { kind: 'other', name: step.message.type, status: 'completed' } });
    }
  }
  const last = messages.filter((m) => m.role === 'assistant').at(-1); if (last) last.final = true;
  return messages;
}
