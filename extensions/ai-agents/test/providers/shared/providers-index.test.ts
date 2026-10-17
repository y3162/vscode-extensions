import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { mock, test, type TestContext } from 'node:test';
import { createSession, cursorNodeVersionSupported, interruptCursorBackgroundShell, listCursorSdkSessions, loadCodexSdk, loadCursorSdkForSession, writeBaselineFile } from '../../../src/providers/index.js';
import { createCursorSdkLoader, cursorSdkRuntimeEntry, loadCursorSdk, loadCursorSdkEntry, loadPublishedCursorSdk } from '../../../src/providers/cursor-sdk.js';
import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';
import { CursorTerminals } from '../../../src/providers/cursor-terminals.js';
import type { AgentSession, AgentUpdate, Selection, SessionSummary, TerminalRecord } from '../../../src/types.js';

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;
type CodexModule = Awaited<ReturnType<Loaders['codex']>>;
type CursorModule = Awaited<ReturnType<Loaders['cursor']>>;

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function loader(overrides: Partial<Loaders> = {}): Loaders {
  return {
    codex: async () => { throw new Error('Unexpected Codex SDK load'); },
    cursor: async () => { throw new Error('Unexpected Cursor SDK load'); },
    ...overrides,
  };
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function codexModule(script: {
  events?: unknown[];
  error?: Error;
  startWithoutId?: boolean;
  onRun?: (input: unknown, options: unknown) => void;
}) {
  const constructorOptions: unknown[] = [];
  const started: unknown[] = [];
  const resumed: Array<{ id: string; options: unknown }> = [];
  const calls: Array<{ id?: string; input: unknown; options: unknown }> = [];
  let sequence = 0;
  function makeThread(id?: string) {
    return {
      id,
      async runStreamed(input: unknown, options: unknown) {
        calls.push({ id, input, options });
        script.onRun?.(input, options);
        if (script.error) throw script.error;
        const events = script.events ?? [];
        return { events: (async function* () { yield* events; })() };
      },
    };
  }
  class FakeCodex {
    constructor(options: unknown) { constructorOptions.push(options); }
    startThread(options: unknown) { started.push(options); sequence += 1; return makeThread(script.startWithoutId ? undefined : `thread-${sequence}`); }
    resumeThread(id: string, options: unknown) { resumed.push({ id, options }); return makeThread(id); }
  }
  return {
    sdk: { Codex: FakeCodex } as unknown as CodexModule,
    constructorOptions, started, resumed, calls,
  };
}

function cursorModule(script: {
  auth?: () => Promise<{ status: string }>;
  create?: (options: unknown) => Promise<unknown>;
  resume?: (id: string, options: unknown) => Promise<unknown>;
  listRuns?: (agentId: string, options: unknown) => Promise<unknown>;
  listMessages?: (agentId: string, options: unknown) => Promise<unknown>;
  send?: (payload: unknown, options: Record<string, any>) => Promise<unknown>;
}) {
  const authCalls: number[] = [];
  const creates: unknown[] = [];
  const resumes: Array<{ id: string; options: unknown }> = [];
  const stores: string[] = [];
  const runPages: unknown[] = [];
  const messagePages: unknown[] = [];
  const sends: Array<{ payload: unknown; options: Record<string, any> }> = [];
  const agent = {
    agentId: 'agent-1',
    async send(payload: unknown, options: Record<string, any>) {
      sends.push({ payload, options });
      if (script.send) return script.send(payload, options);
      return { id: 'run-1', status: 'finished', result: 'Cursor answer' };
    },
    async [Symbol.asyncDispose]() {},
  };
  class Store { constructor(root: string) { stores.push(root); } }
  const Agent = {
    async create(options: unknown) { creates.push(options); return script.create ? script.create(options) : agent; },
    async resume(id: string, options: unknown) { resumes.push({ id, options }); return script.resume ? script.resume(id, options) : agent; },
    async listRuns(agentId: string, options: unknown) {
      runPages.push({ agentId, options });
      return script.listRuns ? script.listRuns(agentId, options) : { items: [], nextCursor: undefined };
    },
    messages: {
      async list(agentId: string, options: unknown) {
        messagePages.push({ agentId, options });
        return script.listMessages ? script.listMessages(agentId, options) : [];
      },
    },
  };
  return {
    sdk: {
      Agent,
      Cursor: { auth: { async status() { authCalls.push(1); return script.auth ? script.auth() : { status: 'logged-in' }; } } },
      JsonlLocalAgentStore: Store,
    } as unknown as CursorModule,
    authCalls, creates, resumes, stores, runPages, messagePages, sends,
  };
}

test('Cursor Node support is a pure check across supported and unsupported boundaries', () => {
  assert.equal(cursorNodeVersionSupported('21.99.0'), false);
  assert.equal(cursorNodeVersionSupported('22.12.99'), false);
  assert.equal(cursorNodeVersionSupported('22.13.0'), true);
  assert.equal(cursorNodeVersionSupported('22.20.1'), true);
  assert.equal(cursorNodeVersionSupported('23.0.0'), true);
  assert.equal(cursorNodeVersionSupported('bad'), false);
});

test('Cursor native terminal interrupt matches both shell id and PID and fails closed without a runtime', (t) => {
  const runtime = new CursorBackgroundRuntime();
  t.after(() => runtime.dispose());
  const shells = new Map([[7, { pid: 501 }]]);
  const aborted: number[] = [];
  runtime.release({
    getManager: () => ({ runningShells: shells, abort: (id) => { aborted.push(id); return true; } }),
    dispose() {},
  });

  assert.equal(interruptCursorBackgroundShell(7, 502, runtime), false, 'a different PID is never interrupted');
  assert.equal(interruptCursorBackgroundShell(8, 501, runtime), false, 'a different shell is never interrupted');
  assert.equal(interruptCursorBackgroundShell(7, 501, runtime), true);
  assert.deepEqual(aborted, [7]);
  assert.equal(interruptCursorBackgroundShell(7, 501, null), false, 'absence of the worker runtime keeps the normal signal fallback available');
});

test('Cursor loader enforces the Node floor before loading and published SDK resolution is local', async (t) => {
  const cwd = await directory(t);
  let loads = 0;
  await assert.rejects(createSession(
    { provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'too-old'), apiKey: 'key' },
    loader({ cursor: async () => { loads += 1; throw new Error('SDK must not load'); } }),
    true,
    { nodeVersion: '22.12.99' },
  ), /22\.13/);
  assert.equal(loads, 0);
  const published = loadPublishedCursorSdk();
  const loaded = await loadCursorSdk();
  assert.equal(typeof published.Agent.create, 'function');
  assert.equal(typeof published.Cursor.auth.status, 'function');
  assert.equal(loaded.Agent, published.Agent);
});

test('default SDK loaders resolve local modules without constructing clients or starting agents', async () => {
  const codex = await loadCodexSdk();
  const cursor = await loadCursorSdkForSession();
  assert.equal(typeof codex.Codex, 'function');
  assert.equal(typeof cursor.Agent.create, 'function');
});

test('Cursor worker SDK entry selection uses packaged code or the dist fallback without probing outside the worker', () => {
  const directory = '/synthetic/extension/src/providers';
  let probes = 0;
  assert.equal(cursorSdkRuntimeEntry(false, directory, () => { probes += 1; return true; }), undefined);
  assert.equal(probes, 0, 'catalog callers do not probe the worker bundle');

  const packaged = path.join(directory, 'cursor-sdk', 'index.js');
  assert.equal(cursorSdkRuntimeEntry(true, directory, (candidate) => { probes += 1; return candidate === packaged; }), packaged);
  assert.equal(cursorSdkRuntimeEntry(true, directory, () => { probes += 1; return false; }), path.resolve(directory, '../../dist/cursor-sdk/index.js'));
  assert.equal(cursorSdkRuntimeEntry(true, directory), path.resolve(directory, '../../dist/cursor-sdk/index.js'));
  assert.equal(probes, 2);
});

test('the worker runtime loader requires its selected entry without loading the real SDK', async (t) => {
  const cwd = await directory(t);
  const entry = path.join(cwd, 'synthetic-sdk.cjs');
  await writeFile(entry, "module.exports = { marker: 'synthetic SDK entry' };\n");
  const loaded = loadCursorSdkEntry(entry) as unknown as { marker: string };
  assert.deepEqual(loaded, { marker: 'synthetic SDK entry' });
});

test('Cursor SDK loader routes published callers and worker callers through injectable loaders', async () => {
  const directory = '/synthetic/extension/src/providers';
  const sdk = {} as typeof import('@cursor/sdk');
  let publishedCalls = 0;
  let routedEntry: string | undefined;
  const publishedRoute = createCursorSdkLoader({
    runtimeAvailable: () => false,
    directory,
    fileExists: () => { throw new Error('published route must not probe worker files'); },
    loadPublished: () => { publishedCalls += 1; return sdk; },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await publishedRoute(), sdk);
  assert.equal(publishedCalls, 1);
  assert.equal(routedEntry, undefined);

  const packaged = path.join(directory, 'cursor-sdk', 'index.js');
  const workerRoute = createCursorSdkLoader({
    runtimeAvailable: () => true,
    directory,
    fileExists: (entry) => entry === packaged,
    loadPublished: () => { throw new Error('worker route must not use the published SDK'); },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await workerRoute(), sdk);
  assert.equal(routedEntry, packaged);

  routedEntry = undefined;
  const fallbackRoute = createCursorSdkLoader({
    runtimeAvailable: () => true,
    directory,
    fileExists: () => false,
    loadPublished: () => { throw new Error('worker fallback must stay bundled'); },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await fallbackRoute(), sdk);
  assert.equal(routedEntry, path.resolve(directory, '../../dist/cursor-sdk/index.js'));
});

test('createSession selects App Server and ACP transports before SDK loaders', async (t) => {
  const cwd = await directory(t);
  const unavailable = loader({
    codex: async () => { throw new Error('Codex SDK route must not run'); },
    cursor: async () => { throw new Error('Cursor SDK route must not run'); },
  });
  await assert.rejects(createSession({
    provider: 'codex', backend: 'app-server', cwd, model: '', storagePath: cwd,
    codexPath: path.join(cwd, 'missing-codex'), sandbox: 'workspace-write', approval: 'never',
  }, unavailable), /ENOENT|spawn/);
  await assert.rejects(createSession({
    provider: 'cursor', backend: 'acp', cwd, model: '', storagePath: cwd,
    agentPath: path.join(cwd, 'missing-agent'), sandbox: 'enabled',
  }, unavailable), /ENOENT|spawn/);
});

test('Codex SDK starts a configured thread, maps stream items and usage, and retargets only changed models', async (t) => {
  const cwd = await directory(t);
  await writeFile(path.join(cwd, 'hello.txt'), 'new\n');
  const fake = codexModule({ events: [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'assistant', type: 'agent_message', text: 'Hello' } },
    { type: 'item.completed', item: { id: 'file', type: 'file_change', status: 'completed', changes: [{ path: 'hello.txt', kind: 'update', previousText: 'old\n', diff: '@@ -1 +1 @@\n-old\n+new\n' }] } },
    { type: 'item.completed', item: { id: 'command', type: 'command_execution', status: 'failed', command: 'git status', aggregated_output: 'clean', exit_code: 2 } },
    { type: 'item.completed', item: { id: 'todo', type: 'todo_list', items: [{ text: 'ship', completed: false }] } },
    { type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'docs' } },
    { type: 'item.completed', item: { id: 'unknown', type: 'reasoning', text: 'hidden' } },
    { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 1 } },
  ] });
  const load = loader({ codex: async () => fake.sdk });
  const identities: SessionSummary[] = [];
  const session = await createSession({
    provider: 'codex', cwd, model: 'gpt-test', modelParams: [{ id: 'modelReasoningEffort', value: 'high' }], storagePath: cwd,
    apiKey: 'explicit-key', codexPath: '/opt/codex', sandbox: 'read-only', approval: 'never', network: true, webSearch: 'live', additionalDirectories: ['/extra'],
    onIdentity: (identity) => identities.push(identity),
  }, load);
  const constructor = fake.constructorOptions[0] as Record<string, unknown>;
  assert.equal(constructor.apiKey, 'explicit-key');
  assert.equal(constructor.codexPathOverride, '/opt/codex');
  assert.deepEqual(fake.started[0], {
    workingDirectory: cwd, model: 'gpt-test', modelReasoningEffort: 'high', sandboxMode: 'read-only',
    approvalPolicy: 'never', skipGitRepoCheck: true, networkAccessEnabled: true, webSearchMode: 'live', additionalDirectories: ['/extra'],
  });
  assert.equal(session.sessionId, 'thread-1');
  session.setModel!({ provider: 'codex', cwd, model: 'gpt-test', modelParams: [{ id: 'modelReasoningEffort', value: 'high' }] });
  assert.equal(fake.resumed.length, 0);
  session.setModel!({ provider: 'codex', cwd, model: 'gpt-next', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] });
  assert.equal(fake.resumed[0]?.id, 'thread-1');
  const updates: AgentUpdate[] = [];
  await session.run('prompt', new AbortController().signal, (update) => updates.push(update), undefined, {
    intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-next', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] },
  });
  assert.equal(identities[0]?.id, 'thread-1');
  assert.equal(identities[0]?.title, 'prompt');
  assert.equal(updates.find((update) => update.id === 'assistant')?.text, 'Hello');
  const files = updates.find((update) => update.id === 'file')?.meta?.files;
  assert.equal(files?.[0]?.previousText, 'old\n');
  assert.equal(files?.[0]?.additions, 1);
  assert.equal(files?.[0]?.deletions, 1);
  assert.equal(updates.find((update) => update.id === 'command')?.tool?.exitCode, 2);
  assert.equal(updates.find((update) => update.id === 'todo')?.meta?.todos?.[0]?.content, 'ship');
  assert.equal(updates.find((update) => update.id === 'search')?.tool?.kind, 'search');
  assert.equal(updates.some((update) => update.id === 'unknown'), false);
  assert.deepEqual(updates.find((update) => update.meta?.type === 'usage')?.meta?.usage, {
    inputTokens: 5, outputTokens: 3, cachedInputTokens: 2, cacheWriteInputTokens: 1, reasoningTokens: 1, totalTokens: 8,
    scope: 'session', source: 'codex-sdk', inputIncludesCache: true,
  });
  assert.deepEqual(fake.calls[0]?.input, 'prompt');
  await session.dispose();
});

test('Codex auth environment fallback, resume, approval refusal, images, and failure cleanup are explicit', async (t) => {
  const cwd = await directory(t);
  await withEnv({ CODEX_API_KEY: 'environment-key' }, async () => {
    const resumed = codexModule({ events: [] });
    const session = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd, resumeId: 'saved-thread', sandbox: 'invalid' }, loader({ codex: async () => resumed.sdk }));
    assert.equal((resumed.constructorOptions[0] as { apiKey?: string }).apiKey, 'environment-key');
    assert.equal(resumed.resumed[0]?.id, 'saved-thread');
    assert.deepEqual(resumed.resumed[0]?.options, {
      workingDirectory: cwd, model: undefined, modelReasoningEffort: undefined, sandboxMode: 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true,
    });
    await session.dispose();
  });
  let loaded = 0;
  await assert.rejects(createSession({ provider: 'codex', cwd, model: '', storagePath: cwd, approval: 'on-request' }, loader({ codex: async () => { loaded += 1; throw new Error('must not load'); } })), /App Server/);
  assert.equal(loaded, 0);

  const imageSdk = codexModule({ events: [] });
  const imageSession = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loader({ codex: async () => imageSdk.sdk }), false, {
    writeImages: async (images) => { assert.equal(images.length, 1); return ['/synthetic/image.png']; },
  });
  await imageSession.run('image prompt', new AbortController().signal, () => {}, { images: [{ mimeType: 'image/png', data: 'AA==' }] });
  assert.deepEqual(imageSdk.calls[0]?.input, [
    { type: 'text', text: 'image prompt' }, { type: 'local_image', path: '/synthetic/image.png' },
  ]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(imageSession.run('stop', aborted.signal, () => {}), { name: 'AbortError' });
  await imageSession.dispose();

  const failed = codexModule({ error: new Error('stream setup failed') });
  const failing = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loader({ codex: async () => failed.sdk }));
  await assert.rejects(failing.run('failure', new AbortController().signal, () => {}), /stream setup failed/);
  assert.equal(failed.calls.length, 1);
  await failing.dispose();
});

test('Codex uses OpenAI auth fallback and handles id-less retargets and both stream error events', async (t) => {
  const cwd = await directory(t);
  await withEnv({ CODEX_API_KEY: undefined, OPENAI_API_KEY: 'fixture-key' }, async () => {
    const idless = codexModule({ startWithoutId: true, events: [] });
    const session = await createSession({ provider: 'codex', cwd, model: 'first', storagePath: cwd, sandbox: 'danger-full-access' }, loader({ codex: async () => idless.sdk }));
    assert.equal((idless.constructorOptions[0] as { apiKey?: string }).apiKey, 'fixture-key');
    assert.equal((idless.started[0] as { sandboxMode: string }).sandboxMode, 'danger-full-access');
    assert.equal(session.sessionId, undefined);
    session.setModel!({ provider: 'codex', cwd, model: 'second' });
    assert.equal(idless.started.length, 2);
    assert.deepEqual(idless.resumed, []);
    await session.run('prompt', new AbortController().signal, () => {});
    await session.dispose();

    for (const [event, message] of [
      [{ type: 'turn.failed', error: { message: 'turn failed' } }, /turn failed/],
      [{ type: 'error', message: 'stream error' }, /stream error/],
    ] as const) {
      const failed = codexModule({ events: [event] });
      const failing = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loader({ codex: async () => failed.sdk }));
      await assert.rejects(failing.run('failure', new AbortController().signal, () => {}), message);
      assert.equal(failed.calls.length, 1);
      await failing.dispose();
    }
  });
});

test('Codex forwards workspace changes to background listeners and falls back to the active turn', async (t) => {
  const cwd = await directory(t);
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd, stdio: 'ignore' });
  const file = path.join(cwd, 'tracked.txt');
  await writeFile(file, 'before\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd, stdio: 'ignore' });

  const changed = codexModule({ onRun: () => { writeFileSync(file, 'after\n'); } });
  const session = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loader({ codex: async () => changed.sdk }));
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  const direct: AgentUpdate[] = [];
  await session.run('edit', new AbortController().signal, (update) => direct.push(update));
  assert.equal(direct.some((update) => update.text === 'diff updated'), false);
  const change = background.find((update) => update.text === 'diff updated');
  assert.equal(change?.meta?.files?.[0]?.path, 'tracked.txt');
  assert.equal(change?.meta?.files?.[0]?.previousText, 'before\n');
  assert.equal(change?.meta?.files?.[0]?.additions, 1);
  unsubscribe();
  await session.dispose();

  await writeFile(file, 'before\n');
  const withoutListener = codexModule({ onRun: () => { writeFileSync(file, 'after\n'); } });
  const fallback = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loader({ codex: async () => withoutListener.sdk }));
  const updates: AgentUpdate[] = [];
  await fallback.run('edit', new AbortController().signal, (update) => updates.push(update));
  assert.equal(updates.find((update) => update.text === 'diff updated')?.meta?.files?.[0]?.previousText, 'before\n');
  await fallback.dispose();
});

test('Cursor SDK selects authentication, storage, sandbox, model, mode, and final plan output', async (t) => {
  const cwd = await directory(t);
  const storage = path.join(cwd, 'storage');
  const fake = cursorModule({
    send: async (_payload, options) => {
      options.onDelta({ update: { type: 'tool-call-completed', callId: 'plan-call', toolCall: { type: 'createPlan', args: { plan: '# Structured plan' } } } });
      const result = { id: 'run-1', status: 'finished', result: 'answer', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 0, totalTokens: 5 } };
      return { ...result, async *stream() {}, async wait() { return result; }, async cancel() {} };
    },
  });
  const identities: SessionSummary[] = [];
  const options = { provider: 'cursor' as const, cwd, model: '', modelParams: [{ id: 'fast', value: 'true' }], storagePath: storage, apiKey: 'explicit-key', sandbox: 'disabled', mode: 'plan' as const, additionalDirectories: ['/extra'], onIdentity: (identity: SessionSummary) => identities.push(identity) };
  const session = await createSession(options, loader({ cursor: async () => fake.sdk }), true);
  const created = fake.creates[0] as { apiKey?: string; model: { id: string; params?: unknown[] }; mode: string; local: { cwd: string; sandboxOptions: { enabled: boolean }; dirs?: string[]; settingSources: string[] } };
  assert.equal(created.apiKey, 'explicit-key');
  assert.deepEqual(created.model, { id: 'auto', params: options.modelParams });
  assert.equal(created.mode, 'plan');
  assert.equal(created.local.cwd, cwd);
  assert.equal(created.local.sandboxOptions.enabled, false);
  assert.deepEqual(created.local.dirs, ['/extra']);
  assert.deepEqual(created.local.settingSources, ['project', 'user']);
  assert.deepEqual(fake.stores, [storage]);
  assert.deepEqual(fake.authCalls, []);
  assert.equal(identities[0]?.id, 'agent-1');
  session.setModel!({ provider: 'cursor', cwd, model: 'composer-2.5', modelParams: [{ id: 'context', value: 'large' }] });
  await session.setMode!('ask');
  await session.setMode!('agent');
  const updates: AgentUpdate[] = [];
  await session.run('prompt', new AbortController().signal, (update) => updates.push(update));
  assert.equal(fake.sends[0]?.options.mode, 'agent');
  assert.deepEqual(fake.sends[0]?.options.model, { id: 'composer-2.5', params: [{ id: 'context', value: 'large' }] });
  assert.equal(updates.find((update) => update.id === 'plan-plan-call')?.meta?.plan?.markdown, '# Structured plan');
  assert.equal(updates.some((update) => update.id === 'plan-text'), false);
  assert.equal(updates.some((update) => update.text === 'answer'), true);
  assert.equal(updates.find((update) => update.meta?.type === 'usage')?.meta?.usage?.cacheWriteInputTokens, 1);
  assert.equal(identities.at(-1)?.title, 'prompt');
  await session.dispose();
});

test('Cursor SDK maps image attachments into the SDK payload', async (t) => {
  const cwd = await directory(t);
  const fake = cursorModule({
    send: async () => ({
      id: 'image-run', status: 'finished', result: 'The synthetic image contains a blue square.',
      async *stream() {},
      async wait() { return { id: 'image-run', status: 'finished', result: 'The synthetic image contains a blue square.' }; },
      async cancel() {},
    }),
  });
  const session = await createSession(
    { provider: 'cursor', cwd, model: 'composer-2.5', storagePath: path.join(cwd, 'images'), apiKey: 'fixture-key' },
    loader({ cursor: async () => fake.sdk }),
    true,
  );
  try {
    const updates: AgentUpdate[] = [];
    await session.run('Describe this image', new AbortController().signal, (update) => updates.push(update), {
      images: [{ mimeType: 'image/png', data: 'synthetic-base64-pixels' }],
    });
    assert.deepEqual(fake.sends[0]?.payload, {
      text: 'Describe this image',
      images: [{ data: 'synthetic-base64-pixels', mimeType: 'image/png' }],
    });
    assert.equal(updates.find((update) => update.id === 'result')?.text, 'The synthetic image contains a blue square.');
  } finally {
    await session.dispose();
  }
});

test('Cursor captures tool file baselines, prioritizes streamed usage, and retains a plan fallback', async (t) => {
  const cwd = await directory(t);
  const file = path.join(cwd, 'edited.txt');
  await writeFile(file, 'before\n');
  const editStarted = { agent_id: 'agent-1', run_id: 'run-1', type: 'tool_call', call_id: 'edit-1', name: 'Edit', status: 'running', args: { path: 'edited.txt' } };
  const editFinished = { ...editStarted, status: 'completed', result: { status: 'success', value: { diffString: '-before\n+after\n' } } };
  const usage = { agent_id: 'agent-1', run_id: 'run-1', type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 6 } };
  const fake = cursorModule({
    send: async () => ({
      id: 'run-1', status: 'finished', result: 'Plan from final result',
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      async *stream() {
        yield editStarted;
        await writeFile(file, 'after\n');
        yield editFinished;
        yield usage;
      },
      async wait() { return { id: 'run-1', status: 'finished', result: 'Plan from final result', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } }; },
      async cancel() {},
    }),
  });
  const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), apiKey: 'key' }, loader({ cursor: async () => fake.sdk }), true);
  const updates: AgentUpdate[] = [];
  await session.run('plan prompt', new AbortController().signal, (update) => updates.push(update), undefined, {
    intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' },
  });
  const fileUpdate = updates.filter((update) => update.meta?.type === 'files').at(-1);
  assert.equal(fileUpdate?.meta?.files?.[0]?.previousText, 'before\n');
  assert.equal(fileUpdate?.meta?.files?.[0]?.additions, 1);
  assert.equal(updates.some((update) => update.id === 'usage-result'), false);
  assert.equal(updates.find((update) => update.meta?.type === 'usage')?.meta?.usage?.inputTokens, 4);
  assert.equal(updates.find((update) => update.meta?.type === 'plan')?.meta?.plan?.markdown, 'Plan from final result');
  await session.dispose();
});

test('Cursor missing conversation metadata requests more input and abort after launch cancels exactly once', async (t) => {
  const cwd = await directory(t);
  let cancellations = 0;
  const requested = cursorModule({ send: async () => ({
    id: 'run-request', status: 'finished',
    async *stream() { yield { agent_id: 'agent-1', run_id: 'run-request', type: 'request', text: 'more details' }; },
    async wait() { return { id: 'run-request', status: 'finished' }; },
    async cancel() { cancellations += 1; },
  }) });
  const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'request'), apiKey: 'key' }, loader({ cursor: async () => requested.sdk }), true);
  await assert.rejects(session.run('prompt', new AbortController().signal, () => {}), /追加入力/);
  assert.equal(cancellations, 1);
  await session.dispose();

  const abort = new AbortController();
  let cancelAfterLaunch = 0;
  const aborted = cursorModule({ send: async () => {
    abort.abort();
    return {
      id: 'run-aborted', status: 'cancelled',
      async *stream() {},
      async wait() { return { id: 'run-aborted', status: 'cancelled' }; },
      async cancel() { cancelAfterLaunch += 1; },
    };
  } });
  const cancelled = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'aborted'), apiKey: 'key' }, loader({ cursor: async () => aborted.sdk }), true);
  await assert.rejects(cancelled.run('prompt', abort.signal, () => {}), { name: 'AbortError' });
  assert.equal(cancelAfterLaunch, 1);
  await cancelled.dispose();
});

test('Cursor aborts from the stream listener once and does not forward later thinking output', async (t) => {
  const cwd = await directory(t);
  const abort = new AbortController();
  let cancellations = 0;
  const fake = cursorModule({ send: async () => ({
    id: 'run-listener-abort', status: 'cancelled',
    async *stream() {
      yield { agent_id: 'agent-1', run_id: 'run-listener-abort', type: 'thinking', text: 'before abort' };
      abort.abort();
      yield { agent_id: 'agent-1', run_id: 'run-listener-abort', type: 'thinking', text: 'after abort' };
    },
    async wait() { return { id: 'run-listener-abort', status: 'cancelled' }; },
    async cancel() { cancellations += 1; },
  }) });
  const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'listener-abort'), apiKey: 'key' }, loader({ cursor: async () => fake.sdk }), true);
  try {
    const updates: AgentUpdate[] = [];
    await assert.rejects(session.run('prompt', abort.signal, (update) => updates.push(update)), { name: 'AbortError' });
    assert.equal(cancellations, 1, 'the registered abort listener cancels the active run once');
    assert.deepEqual(updates.filter((update) => update.meta?.type === 'thinking').map((update) => update.text), ['before abort']);
  } finally { await session.dispose(); }
});

test('Cursor SDK auth and Agent failures leave no session and API-key environment skips status', async (t) => {
  const cwd = await directory(t);
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    const auth = cursorModule({ auth: async () => ({ status: 'logged-out' }) });
    await assert.rejects(createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store') }, loader({ cursor: async () => auth.sdk }), true), /not logged in|未ログイン/);
    assert.equal(auth.authCalls.length, 1);

    const authError = cursorModule({ auth: async () => { throw new Error('status unavailable'); } });
    await assert.rejects(createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'auth-error') }, loader({ cursor: async () => authError.sdk }), true), /status unavailable/);
    assert.equal(authError.creates.length, 0);

    const createError = cursorModule({ create: async () => { throw new Error('Agent.create failed'); } });
    await assert.rejects(createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'create-error'), apiKey: 'key' }, loader({ cursor: async () => createError.sdk }), true), /Agent.create failed/);

    const resumeError = cursorModule({ resume: async () => { throw new Error('Agent.resume failed'); } });
    await assert.rejects(createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'resume-error'), apiKey: 'key', resumeId: 'saved' }, loader({ cursor: async () => resumeError.sdk }), true), /Agent.resume failed/);
    assert.equal(resumeError.resumes[0]?.id, 'saved');

    const resumed = cursorModule({});
    const resumedSession = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'resume-success'), apiKey: 'resume-key', resumeId: 'saved-session' }, loader({ cursor: async () => resumed.sdk }), true);
    assert.equal(resumed.resumes[0]?.id, 'saved-session');
    assert.equal(resumed.resumes[0]?.options && (resumed.resumes[0].options as { apiKey?: string }).apiKey, 'resume-key');
    assert.equal(resumed.creates.length, 0);
    assert.equal(resumedSession.sessionId, 'agent-1');
    await resumedSession.dispose();

    const file = path.join(cwd, 'not-a-directory');
    await writeFile(file, 'fixture');
    const storeFailure = cursorModule({});
    await assert.rejects(createSession({ provider: 'cursor', cwd, model: '', storagePath: file, apiKey: 'key' }, loader({ cursor: async () => storeFailure.sdk }), true), /EEXIST|file already exists|not a directory/i);
  });

  await withEnv({ CURSOR_API_KEY: 'environment-key' }, async () => {
    const envKey = cursorModule({});
    const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'env-key') }, loader({ cursor: async () => envKey.sdk }), true);
    assert.equal(envKey.authCalls.length, 0);
    assert.equal(envKey.creates.length, 1);
    await session.dispose();
  });
});

test('Cursor history pages stored records, falls back to conversations and raw messages, and surfaces API errors', async (t) => {
  const cwd = await directory(t);
  const storedRows = Array.from({ length: 101 }, (_, index) => ({
    uuid: `row-${index}`, message: { agentConversationTurn: { userMessage: { text: `user-${index}`, startedAtMs: index }, steps: [] } },
  }));
  const pages: unknown[] = [];
  const fake = cursorModule({
    listRuns: async (_id, options) => {
      const cursor = (options as { cursor?: string }).cursor;
      return cursor ? { items: [{ id: 'run-late', createdAt: 90 }], nextCursor: undefined } : { items: [{ id: 'run-early', createdAt: 0 }], nextCursor: 'next' };
    },
    listMessages: async (_id, options) => {
      const offset = (options as { offset: number }).offset;
      pages.push(offset);
      return offset === 0 ? storedRows.slice(0, 100) : storedRows.slice(100);
    },
  });
  const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), apiKey: 'key' }, loader({ cursor: async () => fake.sdk }), true);
  const stored: Array<{ id: string; backendTurnId?: string; role: string; text: string }> = [];
  await session.loadTranscript!((message) => stored.push(message));
  assert.equal(stored.length, 101);
  assert.equal(stored[0]?.text, 'user-0');
  assert.equal(stored.at(-1)?.text, 'user-100');
  assert.deepEqual(pages, [0, 100]);
  assert.deepEqual(fake.runPages.map((entry) => (entry as { options: { cursor?: string } }).options.cursor), [undefined, 'next']);
  assert.equal(stored[100]?.backendTurnId, 'run-late');
  await session.dispose();

  const run = {
    id: 'conversation-run', createdAt: 10, supports: () => true,
    async conversation() { return [
      { type: 'shellConversationTurn', turn: { shellCommand: { command: 'ls' }, shellOutput: { stdout: 'ok', stderr: '' } } },
      { type: 'agentConversationTurn', turn: { userMessage: { text: 'question' }, steps: [
        { type: 'assistantMessage', message: { text: 'answer' } },
        { type: 'thinkingMessage', message: { text: 'thought' } },
        { type: 'toolCall', message: { type: 'shell', command: 'pwd' } },
      ] } },
    ]; },
  };
  const fallback = cursorModule({
    listRuns: async () => ({ items: [run], nextCursor: undefined }),
    listMessages: async () => [],
  });
  const conversationSession = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'conversation'), apiKey: 'key' }, loader({ cursor: async () => fallback.sdk }), true);
  const conversation: Array<{ role: string; text: string; final?: boolean }> = [];
  await conversationSession.loadTranscript!((message) => conversation.push(message));
  assert.equal(conversation.some((message) => message.role === 'tool' && message.text.includes('ls')), true);
  assert.equal(conversation.find((message) => message.role === 'assistant')?.final, true);
  assert.equal(conversation.some((message) => message.role === 'status' && message.text === 'thought'), true);
  assert.equal(conversation.some((message) => message.role === 'tool' && message.text.includes('shell')), true);
  await conversationSession.dispose();

  const rawFallback = cursorModule({ listRuns: async () => ({ items: [], nextCursor: undefined }), listMessages: async () => [
    { uuid: 'raw-user', type: 'user', message: { content: [{ type: 'text', text: 'from raw store' }] } },
    { uuid: 'empty', type: 'assistant', message: { content: [] } },
  ] });
  const rawSession = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'raw'), apiKey: 'key' }, loader({ cursor: async () => rawFallback.sdk }), true);
  const raw: Array<{ id: string; role: string; text: string }> = [];
  await rawSession.loadTranscript!((message) => raw.push(message));
  assert.deepEqual(raw, [{ id: 'raw-user', role: 'user', text: 'from raw store' }]);
  await rawSession.dispose();

  const apiError = cursorModule({ listRuns: async () => { throw new Error('history backend failed'); } });
  const errorSession = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'error'), apiKey: 'key' }, loader({ cursor: async () => apiError.sdk }), true);
  await assert.rejects(errorSession.loadTranscript!(() => {}), /history backend failed/);
  await errorSession.dispose();
});

test('Cursor terminal monitoring forwards snapshots, delegates stops, and rejects unavailable operations', async (t) => {
  const cwd = await directory(t);
  const rows: TerminalRecord[] = [{ processId: 'workspace/7.txt', itemId: 'cursor-terminal:workspace/7.txt', command: 'sleep 10', status: 'running' }];
  const update: AgentUpdate = { id: 'cursor-terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: rows } };
  const refresh = t.mock.method(CursorTerminals.prototype, 'refresh', async function (this: CursorTerminals) {
    (this as unknown as { emit: (value: AgentUpdate) => void }).emit(update);
    return rows;
  });
  const stopped: string[] = [];
  const interrupt = t.mock.method(CursorTerminals.prototype, 'interrupt', async (id: string) => { stopped.push(id); });
  let disposed = 0;
  t.mock.method(CursorTerminals.prototype, 'dispose', () => { disposed += 1; });

  const fake = cursorModule({});
  const session = await createSession({
    provider: 'cursor', cwd, model: 'auto', storagePath: path.join(cwd, 'terminals'), apiKey: 'key',
    cursorTerminalDataDir: path.join(cwd, 'cursor-data'),
  }, loader({ cursor: async () => fake.sdk }), true);
  const received: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((value) => received.push(value));
  assert.deepEqual(await session.listBackgroundTerminals!(), rows);
  assert.deepEqual(received, [update]);
  await session.interruptBackgroundTerminal!('workspace/7.txt');
  await session.terminateBackgroundTerminal!('workspace/7.txt');
  assert.deepEqual(stopped, ['workspace/7.txt', 'workspace/7.txt']);
  assert.equal(refresh.mock.calls.length, 1);
  assert.equal(interrupt.mock.calls.length, 2);

  unsubscribe();
  await session.listBackgroundTerminals!();
  assert.equal(refresh.mock.calls.length, 2);
  assert.deepEqual(received, [update], 'unsubscribed listeners receive no later terminal events');
  await session.dispose();
  assert.equal(disposed, 1);

  const unavailable = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'no-terminals'), apiKey: 'key' }, loader({ cursor: async () => fake.sdk }), true);
  assert.deepEqual(await unavailable.listBackgroundTerminals!(), []);
  await assert.rejects(unavailable.interruptBackgroundTerminal!('7'), /terminal monitoring is unavailable/);
  await assert.rejects(unavailable.terminateBackgroundTerminal!('7'), /terminal monitoring is unavailable/);
  await unavailable.dispose();
});

test('Cursor SDK run cleanup stops terminal polling and preserves the original run outcome', async (t) => {
  const cwd = await directory(t);
  let starts = 0;
  let finishes = 0;
  let disposals = 0;
  t.mock.method(CursorTerminals.prototype, 'start', () => { starts += 1; });
  t.mock.method(CursorTerminals.prototype, 'finishRun', async () => {
    finishes += 1;
    throw new Error('terminal refresh failed');
  });
  t.mock.method(CursorTerminals.prototype, 'dispose', () => { disposals += 1; });

  let shouldFail = false;
  let runId = 0;
  const fake = cursorModule({ send: async () => {
    runId += 1;
    const id = `run-${runId}`;
    return {
      id, status: 'finished', result: 'safe result',
      async *stream() { if (shouldFail) throw new Error('cursor stream failed'); },
      async wait() { return { id, status: 'finished', result: 'safe result' }; },
      async cancel() {},
    };
  } });
  const session = await createSession({
    provider: 'cursor', cwd, model: 'auto', storagePath: path.join(cwd, 'terminal-cleanup'), apiKey: 'key',
    cursorTerminalDataDir: path.join(cwd, 'cursor-data'),
  }, loader({ cursor: async () => fake.sdk }), true);
  try {
    const updates: AgentUpdate[] = [];
    await session.run('complete', new AbortController().signal, (update) => updates.push(update));
    assert.equal(updates.some((update) => update.id === 'result' && update.text === 'safe result'), true);
    assert.equal(starts, 1);
    assert.equal(finishes, 1, 'the monitor is refreshed at the end even when that refresh fails');

    shouldFail = true;
    await assert.rejects(session.run('fail', new AbortController().signal, () => {}), /cursor stream failed/);
    assert.equal(starts, 2);
    assert.equal(finishes, 2);
  } finally {
    await session.dispose();
  }
  assert.equal(disposals, 1);
});

test('review baseline snapshots stay inside storage and preserve empty and long-path contents', async (t) => {
  const cwd = await directory(t);
  const storage = path.join(cwd, 'review');
  const escapedInput = '../private/notes with spaces.md';
  const saved = await writeBaselineFile(storage, { path: escapedInput, kind: 'update', previousText: 'before\n' });
  assert.equal(path.dirname(saved), storage);
  assert.match(path.basename(saved), new RegExp(`^${Buffer.from(escapedInput).toString('base64url')}\\-notes with spaces\\.md$`));
  assert.equal(await readFile(saved, 'utf8'), 'before\n');

  const longPath = `${'segment/'.repeat(30)}leaf.txt`;
  const empty = await writeBaselineFile(storage, { path: longPath, kind: 'delete', previousText: null });
  assert.equal(path.dirname(empty), storage);
  assert.equal(path.basename(empty).startsWith(`${Buffer.from(longPath).toString('base64url').slice(0, 80)}-leaf.txt`), true);
  assert.equal(await readFile(empty, 'utf8'), '');
});

test('listCursorSdkSessions uses an injectable published SDK and keeps display metadata', async (t) => {
  const cwd = await directory(t);
  const fake = cursorModule({});
  const sdk = fake.sdk as unknown as { Agent: { list: (options: unknown) => Promise<{ items: unknown[] }> }; JsonlLocalAgentStore: new (root: string) => unknown };
  let listedOptions: unknown;
  sdk.Agent.list = async (options: unknown) => { listedOptions = options; return { items: [
    { agentId: 'one', name: 'Named', summary: 'summary', lastModified: '2026-01-01T00:00:00Z' },
    { agentId: 'two', name: '', summary: 'fallback', lastModified: '' },
    { agentId: 'three', name: '', summary: '', lastModified: '' },
  ] }; };
  const storagePath = path.join(cwd, 'list');
  const rows = await listCursorSdkSessions({ cwd, storagePath, apiKey: 'key' }, () => sdk as unknown as CursorModule);
  assert.deepEqual(rows.map((row) => [row.id, row.title, row.provider, row.cwd]), [
    ['one', 'Named', 'cursor', cwd], ['two', 'fallback', 'cursor', cwd], ['three', 'three', 'cursor', cwd],
  ]);
  assert.equal((listedOptions as { cwd: string }).cwd, cwd);
  assert.equal(typeof (listedOptions as { store?: unknown }).store, 'object');
  assert.equal(rows.every((row) => !Number.isNaN(Date.parse(row.updatedAt))), true);
});

test('the default Cursor SDK route starts the isolated worker instead of loading the SDK in-process', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: { resume() {} }, stderr: { resume() {} },
    send(message: { id: number; method: string }, callback: (error?: Error | null) => void) {
      callback();
      if (message.method !== 'initialize') queueMicrotask(() => child.emit('message', { id: message.id }));
      else queueMicrotask(() => child.emit('message', { id: message.id, value: { ready: true } }));
    },
    kill() { return true; },
  });
  const fork = mock.method(childProcess, 'fork', () => child);
  try {
    const session = await createSession({ provider: 'cursor', cwd: '/synthetic', model: 'auto', storagePath: '/synthetic' });
    assert.equal(typeof session.setModel, 'function');
    assert.equal(fork.mock.calls.length, 1);
    assert.equal(fork.mock.calls[0]?.arguments[2]?.execArgv?.length, 0);
    await session.dispose();
  } finally { fork.mock.restore(); }
});
