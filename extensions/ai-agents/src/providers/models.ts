import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import type { SDKModel } from '@cursor/sdk';
import { annotateParameter } from '../model-settings.js';
import type { AgentModel, Provider } from '../types.js';
import { extensionVersion } from '../version.js';

export interface ModelListOptions {
  provider: Provider;
  cwd?: string;
  apiKey?: string;
  codexPath?: string;
  signal?: AbortSignal;
}

export function cursorModels(models: SDKModel[]): AgentModel[] {
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  const aliases = new Map<string, Set<string>>();
  for (const model of unique) {
    for (const alias of [model.id, ...(model.aliases ?? [])]) {
      const owners = aliases.get(alias) ?? new Set<string>();
      owners.add(model.id);
      aliases.set(alias, owners);
    }
  }
  return unique.map((model): AgentModel => {
    const defaults = new Map((model.variants?.find((variant) => variant.isDefault)?.params ?? []).map((param) => [param.id, param.value]));
    for (const parameter of model.parameters ?? []) {
      if (!defaults.has(parameter.id) && parameter.values[0]) defaults.set(parameter.id, parameter.values[0].value);
    }
    // Parameters and presets describe a model; they do not create more model rows.
    return {
      id: model.id, label: model.displayName || model.id, description: model.description,
      aliases: model.aliases?.filter((alias) => aliases.get(alias)?.size === 1),
      defaultParams: [...defaults].map(([id, value]) => ({ id, value })),
      parameters: model.parameters?.flatMap((parameter) => {
        const annotated = annotateParameter({
          id: parameter.id, label: parameter.displayName || parameter.id, defaultValue: defaults.get(parameter.id),
          values: parameter.values.map((value) => ({ value: value.value, label: value.displayName || value.value })),
        });
        return annotated ? [annotated] : [];
      }),
      presets: model.variants?.map((variant) => ({
        label: variant.displayName, description: variant.description,
        isDefault: variant.isDefault, params: variant.params,
      })),
    };
  });
}

export function codexModel(model: Record<string, unknown>): AgentModel | undefined {
  if (typeof model.model !== 'string' || !model.model || model.hidden === true) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  const values = efforts.flatMap((effort: unknown) => {
    if (!effort || typeof effort !== 'object' || !('reasoningEffort' in effort) || typeof effort.reasoningEffort !== 'string') return [];
    return [{ value: effort.reasoningEffort, label: effort.reasoningEffort,
      description: 'description' in effort && typeof effort.description === 'string' ? effort.description : undefined }];
  });
  const effort = values.length ? annotateParameter({
    id: 'modelReasoningEffort', label: 'Effort', values,
    ...(typeof model.defaultReasoningEffort === 'string' ? { defaultValue: model.defaultReasoningEffort } : {}),
  }) : undefined;
  return {
    id: model.model,
    label: typeof model.displayName === 'string' ? model.displayName : model.model,
    description: typeof model.description === 'string' ? model.description : undefined,
    isDefault: model.isDefault === true,
    ...(effort ? { parameters: [effort] } : {}),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { void promise.catch(() => undefined); reject(signal.reason); return; }
    signal.addEventListener('abort', aborted, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted);
      reject(error);
    });
  });
}

export async function listModels(options: ModelListOptions): Promise<AgentModel[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (options.provider === 'cursor') {
    const { Cursor } = await import('@cursor/sdk');
    signal.throwIfAborted();
    if (!options.apiKey && !process.env.CURSOR_API_KEY) {
      const auth = await abortable(Cursor.auth.status(), signal);
      if (auth.status !== 'logged-in') {
        throw new Error('Cursor SDKに未ログインです。サイドバーの「ログイン」または「APIキー」から認証してください。');
      }
    }
    return cursorModels(await abortable(Cursor.models.list({ apiKey: options.apiKey || undefined }), signal));
  }
  return listCodexModels(options, signal);
}

type RpcResult = { data?: unknown; nextCursor?: unknown };
type RpcResponse = { id?: number; result?: RpcResult; error?: { message: string } };

async function listCodexModels(options: ModelListOptions, signal: AbortSignal): Promise<AgentModel[]> {
  // Use the public npm CLI entry, including its own platform-binary resolver.
  // ELECTRON_RUN_AS_NODE allows this to work without a separate Node on PATH.
  const bundledCli = options.codexPath ? undefined : createRequire(__filename).resolve('@openai/codex/bin/codex.js');
  const args = ['app-server', '--listen', 'stdio://'];
  const key = options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  if (key) args.push('-c', 'model_providers.openai.env_key="CODEX_API_KEY"');
  const child = spawn(options.codexPath || process.execPath, bundledCli ? [bundledCli, ...args] : args, {
    cwd: options.cwd || undefined,
    env: { ...process.env, ...(bundledCli ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...(key ? { CODEX_API_KEY: key } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (result: RpcResult) => void; reject: (error: unknown) => void }>();
  let nextId = 0;
  let failure: Error | undefined;
  let started = false;
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const processExitError = (code = child.exitCode, exitSignal = child.signalCode): Error =>
    new Error(`Codexのモデル一覧取得プロセスが終了しました (${code ?? exitSignal ?? 'signal'})。`);
  const inputError = (error: unknown): Error => {
    const reason = error instanceof Error ? error : new Error(String(error));
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EPIPE') return reason;
    if (child.exitCode !== null || child.signalCode !== null) return processExitError();
    return new Error('Codexのモデル一覧取得中にプロセスとの通信が切断されました。', { cause: reason });
  };
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    if (!started) rejectStarted(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  const stopChild = () => {
    if (!started || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(); } catch { /* A process can exit between the state check and kill(). */ }
  };
  const aborted = () => { fail(signal.reason); stopChild(); };
  child.once('spawn', () => {
    started = true;
    resolveStarted();
    if (failure || signal.aborted) stopChild();
  });
  child.on('error', fail);
  child.stdin.on('error', (error) => fail(inputError(error)));
  child.stderr.resume();
  child.on('exit', (code, exitSignal) => fail(processExitError(code, exitSignal)));
  lines.on('line', (line) => {
    let response: RpcResponse;
    try { response = JSON.parse(line) as RpcResponse; }
    catch { fail(new Error('Codexからのモデル一覧の応答が不正です。')); return; }
    if (response.id === undefined) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result ?? {});
  });
  signal.addEventListener('abort', aborted, { once: true });
  const write = (message: unknown): boolean => {
    if (failure) return false;
    if (!started || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable || child.stdin.destroyed) {
      fail(child.exitCode !== null || child.signalCode !== null
        ? processExitError()
        : new Error('Codexのモデル一覧取得中にプロセスとの通信が切断されました。'));
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      fail(inputError(error));
      return false;
    }
  };
  const request = (method: string, params: object) => new Promise<RpcResult>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  });
  try {
    await startup;
    await request('initialize', { clientInfo: { name: 'ai_agents_vscode', title: 'AI Agents', version: extensionVersion } });
    if (!write({ method: 'initialized', params: {} })) throw failure;
    const models = new Map<string, AgentModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Codexのモデル一覧が不正です。');
      for (const model of page.data as Record<string, unknown>[]) {
        const entry = model && codexModel(model);
        if (entry && !models.has(entry.id)) models.set(entry.id, entry);
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codexのモデル一覧のページ取得が循環しています。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  } finally {
    signal.removeEventListener('abort', aborted);
    lines.close();
    if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end();
    stopChild();
    if (started && child.exitCode === null && child.signalCode === null) {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* The process may have exited before the timer fired. */ }
      }, 1500);
      forceKill.unref();
      child.once('exit', () => clearTimeout(forceKill));
    }
  }
}
