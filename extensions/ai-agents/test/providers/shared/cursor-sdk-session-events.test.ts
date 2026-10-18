import assert from 'node:assert/strict';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test, type TestContext } from 'node:test';

import { createSession, cursorNodeVersionSupported, interruptCursorBackgroundShell, listCursorSdkSessions, loadCodexSdk, loadCursorSdkForSession, writeBaselineFile } from '../../../src/providers/index.js';

import type { AgentSession, AgentUpdate, Selection, SessionSummary, TerminalRecord } from '../../../src/types.js';

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

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CursorModule = Awaited<ReturnType<Loaders['cursor']>>;

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
