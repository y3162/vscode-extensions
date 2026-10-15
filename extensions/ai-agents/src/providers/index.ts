import { mkdir } from 'node:fs/promises';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import type { AgentSession, Selection } from '../types.js';
import { codexUpdate, cursorUpdate } from './events.js';

export interface SessionOptions extends Selection {
  storagePath: string;
  apiKey?: string;
  codexPath?: string;
}

const sdkLoaders = {
  codex: () => import('@openai/codex-sdk'),
  cursor: () => import('@cursor/sdk'),
};

export async function createSession(options: SessionOptions, loaders = sdkLoaders): Promise<AgentSession> {
  if (options.provider === 'codex') {
    const { Codex } = await loaders.codex();
    const codex = new Codex({
      apiKey: options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
      codexPathOverride: options.codexPath || undefined,
    });
    const thread = codex.startThread({
      workingDirectory: options.cwd,
      model: options.model || undefined,
      modelReasoningEffort: options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value as ModelReasoningEffort | undefined,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });
    return {
      async run(prompt, signal, emit) {
        signal.throwIfAborted();
        const { events } = await thread.runStreamed(prompt, { signal });
        for await (const event of events) {
          signal.throwIfAborted();
          if (event.type === 'turn.failed') throw new Error(event.error.message);
          if (event.type === 'error') throw new Error(event.message);
          if ('item' in event) {
            const update = codexUpdate(event.item);
            if (update) emit(update);
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
  const agent = await Agent.create({
    apiKey: options.apiKey || undefined,
    model: { id: options.model || 'auto', ...(options.modelParams?.length ? { params: options.modelParams } : {}) },
    local: {
      cwd: options.cwd,
      store: new JsonlLocalAgentStore(options.storagePath),
      sandboxOptions: { enabled: true },
    },
  });
  return {
    async run(prompt, signal, emit) {
      signal.throwIfAborted();
      const run = await agent.send(prompt);
      // send() can finish after Stop was clicked; cancel that newly created run too.
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= run.cancel();
        // Observe rejections immediately, including when the stream is blocked.
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let index = 0;
      let hasAssistant = false;
      try {
        for await (const event of run.stream()) {
          const update = cursorUpdate(event, index++);
          if (update?.text && !signal.aborted) {
            hasAssistant ||= update.role === 'assistant';
            emit(update);
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
      } finally {
        signal.removeEventListener('abort', cancel);
        await cancellation;
      }
    },
    async dispose() { await agent[Symbol.asyncDispose](); },
  };
}
