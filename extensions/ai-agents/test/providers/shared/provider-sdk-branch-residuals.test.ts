import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSession, interruptCursorBackgroundShell } from '../../../src/providers/index.js';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';
import type { SessionOptions } from '../../../src/providers/session-options.js';
import type { AgentUpdate } from '../../../src/types.js';

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CursorScript = {
  send?: (payload: unknown, options: Record<string, any>) => Promise<unknown>;
  runs?: unknown[];
  messages?: unknown[];
};

function cursorLoaders(script: CursorScript) {
  const sent: Array<{ payload: unknown; options: Record<string, any> }> = [];
  const agent = {
    agentId: 'synthetic-agent',
    async send(payload: unknown, options: Record<string, any>) {
      sent.push({ payload, options });
      if (script.send) return script.send(payload, options);
      return {
        id: 'synthetic-run', status: 'finished', result: undefined,
        async *stream() {}, async wait() { return { id: 'synthetic-run', status: 'finished' }; }, async cancel() {},
      };
    },
    async [Symbol.asyncDispose]() {},
  };
  const sdk = {
    Agent: {
      async create() { return agent; },
      async resume() { return agent; },
      async listRuns() { return { items: script.runs ?? [], nextCursor: undefined }; },
      messages: { async list() { return script.messages ?? []; } },
    },
    Cursor: { auth: { async status() { return { status: 'logged-in' }; } } },
    JsonlLocalAgentStore: class { constructor(readonly root: string) {} },
  };
  return {
    sent,
    loaders: {
      codex: async () => { throw new Error('unexpected Codex loader'); },
      cursor: async () => sdk as unknown as Awaited<ReturnType<Loaders['cursor']>>,
    },
  };
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ai-agents-provider-branches-'));
}

function baseOptions(cwd: string, extra: Partial<SessionOptions> = {}): SessionOptions {
  return { provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), apiKey: 'fixture-key', ...extra };
}

test('Cursor SDK covers empty assistant chunks, missing patch paths, ignored plan callbacks, and plan result fallback', async () => {
  const cwd = await tempDirectory();
  const identities: string[] = [];
  const updates: AgentUpdate[] = [];
  const fake = cursorLoaders({
    async send(_payload, options) {
      options.onDelta({ update: { type: 'tool-call-started', callId: 'start', toolCall: { type: 'createPlan', args: { plan: 'ignored' } } } });
      options.onDelta({ update: { type: 'tool-call-completed', callId: 'wrong-tool', toolCall: { type: 'write', args: { plan: 'ignored' } } } });
      options.onDelta({ update: { type: 'tool-call-completed', callId: 'bad-plan', toolCall: { type: 'createPlan', args: { plan: 3 } } } });
      options.onDelta({ update: { type: 'tool-call-completed', callId: 'blank-plan', toolCall: { type: 'createPlan', args: { plan: '  ' } } } });
      return {
        id: 'cursor-fallback', status: 'finished', result: '  proposed plan  ',
        async *stream() {
          yield { type: 'assistant', message: { content: [{ type: 'image', data: 'ignored' }] } };
          yield { type: 'tool_call', call_id: 'patch', name: 'edit', status: 'completed', args: {}, result: { status: 'success', value: { diffString: '-before\n+after\n' } } };
          yield { type: 'status', status: 'ready', message: 'status without metadata' };
        },
        async wait() { return { id: 'cursor-fallback', status: 'finished', result: '  proposed plan  ' }; },
        async cancel() {},
      };
    },
  });
  const options = baseOptions(cwd, { mode: 'plan', onIdentity: (value) => identities.push(value.title) });
  const session = await createSession(options, fake.loaders, true);
  try {
    await session.setMode!('ask'); // Ask is unsupported by this SDK; Plan remains active.
    session.setModel!({ provider: 'cursor', cwd, model: '' });
    await session.run('', new AbortController().signal, (update) => updates.push(update));
    assert.equal(fake.sent[0]?.options.mode, 'plan');
    assert.deepEqual(fake.sent[0]?.options.model, { id: 'auto' });
    assert.equal(updates.some((update) => update.meta?.plan?.source === 'sdk-createPlan'), false);
    assert.equal(updates.find((update) => update.id === 'plan-text')?.meta?.plan?.markdown, 'proposed plan');
    assert.equal(updates.find((update) => update.id === 'result')?.text, '  proposed plan  ');
    const patch = updates.find((update) => update.meta?.type === 'files')?.meta?.files?.[0];
    assert.equal(patch?.path, 'patch');
    assert.equal(patch?.previousText, undefined, 'a diff without a path never invents a captured file baseline');
    assert.equal(updates.find((update) => update.text === 'ready')?.meta, undefined);
    assert.deepEqual(identities, ['Cursor', 'Cursor'], 'empty prompts use the stable provider title');
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Cursor SDK uses generic error text and skips conversation data for runs without support', async () => {
  const cwd = await tempDirectory();
  const errorSdk = cursorLoaders({ async send() {
    return { id: 'error-run', status: 'error', async *stream() {}, async wait() { return { id: 'error-run', status: 'error' }; }, async cancel() {} };
  } });
  const failing = await createSession(baseOptions(cwd), errorSdk.loaders, true);
  try {
    await assert.rejects(failing.run!('prompt', new AbortController().signal, () => {}), /Cursorの実行に失敗しました/);
  } finally {
    await failing.dispose();
  }

  let conversationCalls = 0;
  const unsupportedRun = {
    id: 'unsupported-conversation',
    supports() { return false; },
    async conversation() { conversationCalls += 1; return [{ type: 'agentConversationTurn' }]; },
  };
  const historySdk = cursorLoaders({ runs: [unsupportedRun], messages: [] });
  const history = await createSession(baseOptions(cwd), historySdk.loaders, true);
  try {
    const messages: Array<{ id: string; text: string }> = [];
    await history.loadTranscript!((message) => messages.push({ id: message.id, text: message.text }));
    assert.equal(conversationCalls, 0, 'unsupported run metadata is not queried');
    assert.deepEqual(messages, []);
  } finally {
    await history.dispose();
  }

  const rawSdk = cursorLoaders({ messages: [
    { uuid: 'not-text', type: 'user', message: { content: 'not an array' } },
    { uuid: 'mixed', type: 'assistant', message: { content: [null, 5, { text: 7 }, { text: 'kept' }] } },
  ] });
  const rawHistory = await createSession(baseOptions(cwd), rawSdk.loaders, true);
  try {
    const messages: Array<{ id: string; text: string }> = [];
    await rawHistory.loadTranscript!((message) => messages.push({ id: message.id, text: message.text }));
    assert.deepEqual(messages, [{ id: 'mixed', text: 'kept' }]);
  } finally {
    await rawHistory.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Cursor native shell interruption uses the installed worker runtime only when no runtime is supplied', () => {
  assert.equal(interruptCursorBackgroundShell(1, 2), false);
  assert.equal(interruptCursorBackgroundShell(1, 2, null), false);
  const runtime = new CursorBackgroundRuntime();
  let aborted = 0;
  const executor = {
    getManager: () => ({ runningShells: new Map([[1, { pid: 2 }]]), abort: () => { aborted += 1; return true; } }),
    dispose() {},
  };
  runtime.release(executor);
  assert.equal(interruptCursorBackgroundShell(1, 2, runtime), true);
  assert.equal(interruptCursorBackgroundShell(1, 3, runtime), false);
  assert.equal(aborted, 1);
  runtime.dispose();
});

async function makeAppServer() {
  const cwd = await tempDirectory();
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: {
    threadId: 'server-thread', model: 'reported-model',
    thread: { historyMode: 'paginated', turns: [{ id: 'cached-turn', items: [{ type: 'userMessage', text: 'cached transcript' }] }] },
  } });
  else if (request.method === 'thread/turns/list') emit({ id: request.id, error: { message: 'history list unavailable' } });
  else if (request.method === 'thread/read') emit({ id: request.id, result: { turns: [] } });
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [] } });
  else if (request.method === 'thread/list') emit({ id: request.id, result: { threads: [{ id: 'listed-thread', preview: 'preview title' }, { id: '' }] } });
  else if (request.method === 'turn/start') {
    const id = request.params.input[0].text === 'fail-empty' ? 'fail-turn' : 'edge-turn';
    emit({ method: 'turn/started', params: { threadId: 'server-thread', turn: { id } } });
    if (id === 'fail-turn') emit({ method: 'error', params: { turnId: id, willRetry: false } });
    else {
      const item = (type, fields = {}) => emit({ method: 'item/completed', params: { threadId: 'server-thread', item: { type, ...fields } } });
      item('commandExecution');
      item('fileChange', { changes: { malformed: true } });
      item('todoList', { todos: [{ step: 'fallback todo' }, { text: '' }, null] });
      item('', { id: 'bare-type', content: [{ type: 'text', text: 'bare item' }] });
      item('agentMessage', { id: 'assistant-final', text: 'plain plan', phase: 'final_answer' });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'server-thread' } });
      emit({ method: 'turn/plan/updated', params: { threadId: 'server-thread', plan: [{ step: 'plan fallback' }] } });
      emit({ method: 'turn/diff/updated', params: { threadId: 'server-thread', turn: { id }, diff:
        'diff --git a/new.txt b/new.txt\\n--- /dev/null\\n+++ b/new.txt\\n@@ -0,0 +1 @@\\n+new\\n' } });
      emit({ method: 'turn/completed', params: { threadId: 'server-thread', turn: { id, status: 'completed' } } });
    }
    emit({ id: request.id, result: { turn: { id } } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(command, source);
  await chmod(command, 0o755);
  const identities: string[] = [];
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: '', storagePath: cwd, codexPath: command, backend: 'app-server',
    onIdentity: (identity) => identities.push(identity.title),
  });
  return { cwd, session, identities, async cleanup() {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  } };
}

test('Codex App Server normalizes replay, listing, todo, diff, model, and identity fallbacks from synthetic protocol data', async () => {
  const { cwd, session, identities, cleanup } = await makeAppServer();
  try {
    const replay: Array<{ id: string; text: string }> = [];
    await session.loadTranscript!((message) => replay.push({ id: message.id, text: message.text }));
    assert.deepEqual(replay.map((message) => message.text), ['cached transcript'], 'a failed history page replays the cached startup transcript');
    assert.deepEqual((await session.listSessions!()).map((item) => [item.id, item.title]), [['listed-thread', 'preview title']]);

    const updates: AgentUpdate[] = [];
    await session.run('', new AbortController().signal, (update) => updates.push(update), undefined, {
      intent: 'plan', mode: 'plan', selection: { provider: 'codex', cwd, model: '' },
    });
    assert.equal(session.sessionId, 'server-thread');
    assert.equal(updates.some((update) => update.id === 'edge-turn:diff' && update.meta?.files?.[0]?.path === 'new.txt'), true);
    assert.equal(updates.some((update) => update.meta?.todos?.[0]?.content === 'fallback todo'), true);
    assert.equal(updates.find((update) => update.id === 'plan-text')?.meta?.plan?.markdown, 'plain plan');
    assert.equal(updates.some((update) => update.id === 'commandexecution' && update.role === 'tool'), true);
    assert.equal(updates.some((update) => update.id === 'tool:bare-type' || update.text === 'tool: bare item'), true);
    assert.deepEqual(identities, ['Codex', 'Codex']);
    await assert.rejects(session.run!('fail-empty', new AbortController().signal, () => {}), /Codex app-server error/);
  } finally {
    await cleanup();
  }
});
