import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';

import { writeFileSync } from 'node:fs';

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

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CodexModule = Awaited<ReturnType<Loaders['codex']>>;

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
