import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { captureBaseline } from '../change-review.js';
import { writeImageFiles } from '../images.js';
import type { AgentSession, FileChange, SessionSummary } from '../types.js';
import { createCodexAppServerSession } from './codex-app-server.js';
import { createCursorAcpSession } from './cursor-acp.js';
import { codexMeta, cursorMeta } from './details.js';
import { codexUpdate, cursorUpdate } from './events.js';
import type { SessionOptions } from './session-options.js';

export type { SessionOptions } from './session-options.js';

const sdkLoaders = {
  codex: () => import('@openai/codex-sdk'),
  cursor: () => import('@cursor/sdk'),
};

function cursorToolPath(meta: ReturnType<typeof cursorMeta>): string | undefined {
  const file = meta?.type === 'files' ? meta.files?.[0]?.path : undefined;
  return file && file !== 'patch' ? file : undefined;
}

export async function createSession(options: SessionOptions, loaders = sdkLoaders): Promise<AgentSession> {
  if (options.provider === 'codex' && options.backend === 'app-server') return createCodexAppServerSession(options);
  if (options.provider === 'cursor' && options.backend === 'acp') return createCursorAcpSession(options);
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
    const thread = options.resumeId
      ? codex.resumeThread(options.resumeId, threadOptions())
      : codex.startThread(threadOptions());
    function threadOptions() {
      return {
        workingDirectory: options.cwd,
        model: options.model || undefined,
        modelReasoningEffort: options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value as ModelReasoningEffort | undefined,
        sandboxMode,
        approvalPolicy: 'never' as const,
        skipGitRepoCheck: true,
        ...(options.network ? { networkAccessEnabled: true } : {}),
        ...(options.webSearch ? { webSearchMode: options.webSearch as 'disabled' | 'cached' | 'live' } : {}),
        ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
      };
    }
    return {
      get sessionId() { return thread.id ?? undefined; },
      async run(prompt, signal, emit, extras) {
        signal.throwIfAborted();
        const images = await writeImageFiles(extras?.images ?? []);
        const input = images.length
          ? [{ type: 'text' as const, text: prompt }, ...images.map((imagePath) => ({ type: 'local_image' as const, path: imagePath }))]
          : prompt;
        const { events } = await thread.runStreamed(input, { signal });
        for await (const event of events) {
          signal.throwIfAborted();
          if (event.type === 'thread.started') {
            options.onIdentity?.({ id: event.thread_id, title: prompt.slice(0, 80) || 'Codex', updatedAt: new Date().toISOString(), provider: 'codex', cwd: options.cwd });
          }
          if (event.type === 'turn.completed') {
            emit({ id: `usage-${event.type}`, role: 'status', text: '', meta: { type: 'usage', usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
              cacheWriteInputTokens: event.usage.cache_write_input_tokens,
              reasoningTokens: event.usage.reasoning_output_tokens,
              totalTokens: event.usage.input_tokens + event.usage.output_tokens,
            } } });
          }
          if (event.type === 'turn.failed') throw new Error(event.error.message);
          if (event.type === 'error') throw new Error(event.message);
          if ('item' in event) {
            const update = codexUpdate(event.item);
            const meta = codexMeta(event.item);
            if (update) emit(meta ? { ...update, meta } : update);
          }
        }
      },
      async dispose() { /* The SDK starts a subprocess per turn; AbortSignal stops it. */ },
    };
  }

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
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
  const model = { id: options.model || 'auto', ...(options.modelParams?.length ? { params: options.modelParams } : {}) };
  const mode = options.mode === 'plan' ? 'plan' as const : 'agent' as const;
  const agent = options.resumeId
    ? await Agent.resume(options.resumeId, { apiKey: options.apiKey || undefined, model, mode, local })
    : await Agent.create({
      apiKey: options.apiKey || undefined,
      model,
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
  let activeMode = mode;
  return {
    sessionId: agent.agentId,
    async setMode(next) {
      if (next === 'ask') return;
      activeMode = next;
    },
    async loadTranscript(emit) {
      const messages = await Agent.messages.list(agent.agentId, { runtime: 'local', cwd: options.cwd, store });
      for (const message of messages) {
        const text = transcriptText(message.message);
        if (!text) continue;
        emit({ id: message.uuid, role: message.type === 'user' ? 'user' : 'assistant', text });
      }
    },
    async run(prompt, signal, emit, extras) {
      signal.throwIfAborted();
      const payload = extras?.images?.length
        ? { text: prompt, images: extras.images.map((image) => ({ data: image.data, mimeType: image.mimeType })) }
        : prompt;
      const run = await agent.send(payload, { mode: activeMode });
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= run.cancel();
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let index = 0;
      let hasAssistant = false;
      try {
        for await (const event of run.stream()) {
          if (event.type === 'tool_call' && event.status === 'running') {
            const early = cursorMeta(event);
            const filePath = cursorToolPath(early);
            if (filePath) await captureBaseline(options.cwd, filePath, baselines);
          }
          if (event.type === 'thinking' && event.text && !signal.aborted) {
            emit({ id: `thinking-${index}`, role: 'status', text: event.text, meta: { type: 'thinking', append: true } });
          }
          if (event.type === 'usage' && !signal.aborted) {
            const meta = cursorMeta(event);
            if (meta) emit({ id: `usage-${index}`, role: 'status', text: '', meta });
          }
          const update = cursorUpdate(event, index++);
          const meta = withBaseline(cursorMeta(event), baselines, options.cwd);
          if (update?.text && !signal.aborted) {
            hasAssistant ||= update.role === 'assistant';
            emit(meta ? { ...update, meta } : update);
          }
          if (event.type === 'request') {
            await run.cancel();
            throw new Error('追加入力が必要なため停止しました。依頼を具体的にして再送してください。');
          }
        }
        const result = await run.wait();
        if (result.status === 'error') throw new Error(result.error?.message ?? 'Cursorの実行に失敗しました。');
        if (result.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
        if (!hasAssistant && result.result && !signal.aborted) {
          emit({ id: 'result', role: 'assistant', text: result.result });
        }
        options.onIdentity?.({ id: agent.agentId, title: prompt.slice(0, 80) || 'Cursor', updatedAt: new Date().toISOString(), provider: 'cursor', cwd: options.cwd });
      } finally {
        signal.removeEventListener('abort', cancel);
        await cancellation;
      }
    },
    async dispose() { await agent[Symbol.asyncDispose](); },
  };
}

function withBaseline(meta: ReturnType<typeof cursorMeta>, baselines: Map<string, FileChange>, cwd: string) {
  if (meta?.type !== 'files' || !meta.files) return meta;
  return {
    ...meta,
    files: meta.files.map((file) => {
      const saved = baselines.get(path.resolve(cwd, file.path));
      return saved?.previousText !== undefined ? { ...file, previousText: saved.previousText } : file;
    }),
  };
}

function transcriptText(message: unknown): string {
  const body = message && typeof message === 'object' && 'content' in message ? message.content : undefined;
  if (!Array.isArray(body)) return '';
  return body.flatMap((block) => block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('');
}

export async function listCursorSdkSessions(options: Pick<SessionOptions, 'cwd' | 'storagePath' | 'apiKey'>): Promise<SessionSummary[]> {
  const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
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
