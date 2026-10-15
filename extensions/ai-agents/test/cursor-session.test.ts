import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentOptions, SDKMessage, Run, RunResult } from '@cursor/sdk';
import { createSession } from '../src/providers/index.js';
import type { AgentUpdate } from '../src/types.js';

type CursorSdk = Awaited<ReturnType<NonNullable<Parameters<typeof createSession>[1]>['cursor']>>;

async function fixture(t: TestContext, send: () => Promise<Run>, modelParams?: { id: string; value: string }[]) {
  const storagePath = await mkdtemp(join(tmpdir(), 'ai-agents-cursor-test-'));
  t.after(() => rm(storagePath, { recursive: true, force: true }));
  let created: AgentOptions | undefined;
  let disposed = false;
  const sdk = {
    Agent: { async create(options: AgentOptions) {
      created = options;
      return { send, async [Symbol.asyncDispose]() { disposed = true; } };
    } },
    JsonlLocalAgentStore: class {},
  } as unknown as CursorSdk;
  const session = await createSession({ provider: 'cursor', cwd: storagePath, model: '', modelParams, storagePath, apiKey: 'fixture-only' }, {
    cursor: async () => sdk,
    codex: async () => { throw new Error('Unexpected Codex load'); },
  });
  t.after(() => session.dispose());
  return { session, created, disposed: () => disposed };
}

function run(events: SDKMessage[], result: RunResult): Run {
  return {
    async *stream() { yield* events; },
    async wait() { return result; },
    async cancel() {},
  } as Run;
}

test('Cursor session uses sandbox/JSONL storage, continues the agent, and reports final-only results', async (t) => {
  let sends = 0;
  const { session, created, disposed } = await fixture(t, async () => {
    sends++;
    return run([], { id: String(sends), status: 'finished', result: `answer ${sends}` });
  });
  assert.equal(created?.local?.sandboxOptions?.enabled, true);
  assert.ok(created?.local?.store);
  assert.deepEqual(created?.model, { id: 'auto' });
  const updates: AgentUpdate[] = [];
  await session.run('first', new AbortController().signal, (event) => updates.push(event));
  await session.run('follow-up', new AbortController().signal, (event) => updates.push(event));
  assert.deepEqual(updates.map((event) => event.text), ['answer 1', 'answer 2']);
  await session.dispose();
  assert.equal(disposed(), true);
});

test('Stop before Cursor send resolves cancels the new run and emits no late output', async (t) => {
  let release!: (value: Run) => void;
  let cancelled = 0;
  const pending = new Promise<Run>((resolve) => { release = resolve; });
  const { session } = await fixture(t, () => pending);
  const abort = new AbortController();
  const updates: AgentUpdate[] = [];
  const sending = session.run('prompt', abort.signal, (event) => updates.push(event));
  abort.abort();
  const delayed = run([], { id: 'delayed', status: 'cancelled' });
  delayed.cancel = async () => { cancelled++; };
  release(delayed);
  await assert.rejects(sending, { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.deepEqual(updates, []);
});

test('Cursor terminal errors are surfaced instead of treating the stream ending as success', async (t) => {
  const { session } = await fixture(t, async () => run([], {
    id: 'failed', status: 'error', error: { message: 'SDK auth failed' },
  }));
  await assert.rejects(session.run('prompt', new AbortController().signal, () => {}), /SDK auth failed/);
});

test('Cursor assistant and thinking chunks collapse without duplicating a snapshot', async (t) => {
  const base = { agent_id: 'agent-1', run_id: 'run-1' };
  const { session } = await fixture(t, async () => run([
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' world' }] } },
    { ...base, type: 'thinking', text: 'Think' },
    { ...base, type: 'thinking', text: 'Think more' },
    { ...base, type: 'tool_call', call_id: 'tool1', name: 'Shell', status: 'completed', args: { command: 'git status' } },
  ] as SDKMessage[], { id: 'run', status: 'finished' }));
  const updates: AgentUpdate[] = [];
  await session.run('prompt', new AbortController().signal, (event) => updates.push(event));
  const assistants = updates.filter((update) => update.role === 'assistant');
  assert.equal(assistants.at(-1)?.text, 'Hello world');
  assert.equal(new Set(assistants.map((update) => update.id)).size, 1);
  assert.equal(updates.filter((update) => update.meta?.type === 'thinking').at(-1)?.text, 'Think more');
  assert.equal(updates.find((update) => update.tool?.name === 'Shell')?.tool?.kind, 'git');
});

test('Cursor selected catalog parameters are forwarded to the SDK', async (t) => {
  const params = [{ id: 'fixture-mode', value: 'fixture-value' }];
  const { created } = await fixture(t, async () => run([], { id: 'run', status: 'finished' }), params);
  assert.deepEqual(created?.model?.params, params);
});
