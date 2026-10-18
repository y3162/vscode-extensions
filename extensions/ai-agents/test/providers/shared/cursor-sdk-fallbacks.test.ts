import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createSession, interruptCursorBackgroundShell } from '../../../src/providers/index.js';

import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';

import type { SessionOptions } from '../../../src/providers/session-options.js';

import type { AgentUpdate } from '../../../src/types.js';

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

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CursorScript = {
  send?: (payload: unknown, options: Record<string, any>) => Promise<unknown>;
  runs?: unknown[];
  messages?: unknown[];
};

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
