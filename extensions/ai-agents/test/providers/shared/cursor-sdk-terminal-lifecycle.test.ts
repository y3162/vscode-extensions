import assert from 'node:assert/strict';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test, type TestContext } from 'node:test';

import { createSession, cursorNodeVersionSupported, interruptCursorBackgroundShell, listCursorSdkSessions, loadCodexSdk, loadCursorSdkForSession, writeBaselineFile } from '../../../src/providers/index.js';

import { CursorTerminals } from '../../../src/providers/cursor-terminals.js';

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
