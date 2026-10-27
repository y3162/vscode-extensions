import assert from 'node:assert/strict';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test, type TestContext } from 'node:test';

import { createSession, cursorNodeVersionSupported, interruptCursorBackgroundShell, listCursorSdkSessions, loadCodexSdk, loadCursorSdkForSession, writeBaselineFile } from '../../../src/providers/index.js';

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
  const sdk = fake.sdk as unknown as { Agent: { list: (options: unknown) => Promise<{ items: unknown[] }>; messages: { list: (agentId: string, options: unknown) => Promise<unknown[]> } }; JsonlLocalAgentStore: new (root: string) => unknown };
  let listedOptions: unknown;
  sdk.Agent.list = async (options: unknown) => { listedOptions = options; return { items: [
    { agentId: 'one', name: 'Named', summary: 'summary', lastModified: '2026-01-01T00:00:00Z' },
    { agentId: 'two', name: '', summary: 'fallback', lastModified: '' },
    { agentId: 'three', name: '', summary: '', lastModified: '' },
    { agentId: 'four', name: 'New Agent', summary: 'Useful summary', lastModified: '' },
    { agentId: 'five', name: 'New Agent', summary: '', lastModified: '' },
    { agentId: 'six', name: '', summary: '', lastModified: '' },
  ] }; };
  sdk.Agent.messages = { async list(agentId: string) {
    if (agentId === 'six') throw new Error('messages unavailable');
    return agentId === 'five' ? [{ uuid: 'first', message: { agentConversationTurn: { userMessage: { text: 'First prompt\nDetails' }, steps: [] } } }] : [];
  } } as never;
  const storagePath = path.join(cwd, 'list');
  const rows = await listCursorSdkSessions({ cwd, storagePath, apiKey: 'key' }, () => sdk as unknown as CursorModule);
  assert.deepEqual(rows.map((row) => [row.id, row.title, row.provider, row.cwd]), [
    ['one', 'Named', 'cursor', cwd], ['two', 'fallback', 'cursor', cwd], ['three', 'three', 'cursor', cwd],
    ['four', 'Useful summary', 'cursor', cwd], ['five', 'First prompt', 'cursor', cwd], ['six', 'six', 'cursor', cwd],
  ]);
  assert.deepEqual(rows.map((row) => row.titleSource), ['provider', 'provider', 'local', 'provider', 'local', 'local']);
  assert.equal((listedOptions as { cwd: string }).cwd, cwd);
  assert.equal(typeof (listedOptions as { store?: unknown }).store, 'object');
  assert.equal(rows.every((row) => !Number.isNaN(Date.parse(row.updatedAt))), true);
});
