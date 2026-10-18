import assert from 'node:assert/strict';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test, type TestContext } from 'node:test';

import type { SDKMessage } from '@cursor/sdk';

import type { createSession } from '../../../src/providers/index.js';

import type { AgentUpdate, SessionSummary, TurnOptions } from '../../../src/types.js';

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CursorSdk = Awaited<ReturnType<Loaders['cursor']>>;

async function directory(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-round5-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Cursor resumes without an explicit key and applies empty model and per-turn mode fallbacks', async (t) => {
  const cwd = await directory(t);
  const resumeCalls: Array<{ id: string; options: Record<string, unknown> }> = [];
  const sends: Array<{ options: Record<string, unknown> }> = [];
  let authCalls = 0;
  const agent = {
    agentId: 'saved-agent',
    async send(_payload: unknown, options: Record<string, any>) {
      sends.push({ options });
      const call = sends.length;
      return {
        id: `run-${call}`,
        status: 'finished',
        result: 'fallback result',
        async *stream() {
          if (call === 2) {
            yield {
              agent_id: 'saved-agent', run_id: 'run-2', type: 'tool_call', call_id: 'plan-call',
              name: 'createPlan', status: 'completed', args: { plan: '# Structured plan' },
            } as unknown as SDKMessage;
          }
        },
        async wait() { return { id: `run-${call}`, status: 'finished', result: 'fallback result' }; },
        async cancel() {},
      };
    },
    async [Symbol.asyncDispose]() {},
  };
  class Store { constructor(_root: string) {} }
  const sdk = {
    Agent: {
      async resume(id: string, options: Record<string, unknown>) { resumeCalls.push({ id, options }); return agent; },
      async create() { throw new Error('resume path must not create'); },
    },
    Cursor: { auth: { async status() { authCalls += 1; return { status: 'logged-in' }; } } },
    JsonlLocalAgentStore: Store,
  } as unknown as CursorSdk;
  const loaders: Loaders = { codex: async () => { throw new Error('Codex not selected'); }, cursor: async () => sdk };
  const identities: SessionSummary[] = [];
  const previousKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    const { createSession } = await import('../../../src/providers/index.js');
    const session = await createSession({
      provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), resumeId: 'saved-agent', mode: 'plan',
      onIdentity: (identity) => identities.push(identity),
    }, loaders, true);
    try {
      assert.equal(authCalls, 1, 'without an explicit or environment key, the SDK auth status is checked');
      assert.equal(resumeCalls[0]?.id, 'saved-agent');
      assert.equal(resumeCalls[0]?.options.apiKey, undefined, 'resume passes no fabricated API key');
      assert.deepEqual(resumeCalls[0]?.options.model, { id: 'auto' });
      assert.equal(resumeCalls[0]?.options.mode, 'plan');

      const updates: AgentUpdate[] = [];
      await session.run('agent turn', new AbortController().signal, (update) => updates.push(update), undefined, {
        intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: '' },
      } satisfies TurnOptions);
      await session.run('plan turn', new AbortController().signal, (update) => updates.push(update), undefined, {
        intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' },
      } satisfies TurnOptions);

      assert.deepEqual(sends.map(({ options }) => [options.mode, options.model]), [
        ['agent', { id: 'auto' }], ['plan', { id: 'auto' }],
      ]);
      assert.equal(updates.some((update) => update.id === 'tool-plan-call' && update.meta?.plan?.markdown === '# Structured plan'), true);
      assert.equal(updates.some((update) => update.id === 'plan-text'), false, 'an SDK plan event prevents a duplicate result-text plan');
      assert.equal(identities.at(-1)?.title, 'plan turn');
    } finally {
      await session.dispose();
    }
  } finally {
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
  }
});

test('Cursor SDK keeps file baselines safe for add, update, delete, patch-only, and empty metadata events', async (t) => {
  const cwd = await directory(t);
  const existing = path.join(cwd, 'existing.txt');
  await writeFile(existing, 'before\n');
  const sends: Array<Record<string, unknown>> = [];
  let runIndex = 0;
  const agent = {
    agentId: 'file-agent',
    async send(_payload: unknown, options: Record<string, unknown>) {
      sends.push(options);
      const current = ++runIndex;
      return {
        id: `file-run-${current}`,
        status: 'finished',
        async *stream() {
          if (current === 1) {
            yield { type: 'tool_call', call_id: 'empty-meta', name: 'search', status: 'running', args: {} } as unknown as SDKMessage;
            yield { type: 'tool_call', call_id: 'capture-update', name: 'edit', status: 'running', args: { path: 'existing.txt' } } as unknown as SDKMessage;
            await writeFile(existing, 'after\n');
            yield { type: 'tool_call', call_id: 'update', name: 'edit', status: 'completed', args: { path: 'existing.txt' }, result: { diffString: '-before\n+after\n' } } as unknown as SDKMessage;
            yield { type: 'tool_call', call_id: 'capture-add', name: 'edit', status: 'running', args: { path: 'new.txt' } } as unknown as SDKMessage;
            yield { type: 'tool_call', call_id: 'add', name: 'write', status: 'completed', args: { path: 'new.txt' }, result: { diffString: '+new file\n' } } as unknown as SDKMessage;
            yield { type: 'tool_call', call_id: 'delete', name: 'delete', status: 'completed', args: { path: 'existing.txt' }, result: { diffString: '-after\n' } } as unknown as SDKMessage;
            yield { type: 'tool_call', call_id: 'patch', name: 'edit', status: 'completed', args: {}, result: { diffString: '-old\n+new\n' } } as unknown as SDKMessage;
          } else if (current === 3) {
            yield { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } } as unknown as SDKMessage;
          }
        },
        async wait() {
          return { id: `file-run-${current}`, status: 'finished', result: current === 2 ? '# result plan' : '# ignored fallback' };
        },
        async cancel() {},
      };
    },
    async [Symbol.asyncDispose]() {},
  };
  class Store { constructor(_root: string) {} }
  const sdk = {
    Agent: { async create() { return agent; }, async resume() { return agent; } },
    Cursor: { auth: { async status() { return { status: 'logged-in' }; } } },
    JsonlLocalAgentStore: Store,
  } as unknown as CursorSdk;
  const loaders: Loaders = { codex: async () => { throw new Error('Codex not selected'); }, cursor: async () => sdk };
  const { createSession } = await import('../../../src/providers/index.js');
  const session = await createSession({ provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), apiKey: 'fixture-key' }, loaders, true);
  try {
    const first: AgentUpdate[] = [];
    await session.run('edit files', new AbortController().signal, (update) => first.push(update), undefined, {
      intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: 'composer', modelParams: [{ id: 'fast', value: 'true' }] },
    } satisfies TurnOptions);
    assert.deepEqual(sends[0]?.model, { id: 'composer', params: [{ id: 'fast', value: 'true' }] });
    const updates = first.flatMap((update) => update.meta?.files ?? []);
    assert.equal(updates.some((file) => file.path === 'existing.txt' && file.kind === 'update' && file.previousText === 'before\n' && file.additions === 1), true);
    assert.equal(updates.some((file) => file.path === 'new.txt' && file.kind === 'add' && file.previousText === null), true);
    assert.equal(updates.some((file) => file.path === 'existing.txt' && file.kind === 'delete' && file.previousText === 'before\n'), true);
    assert.equal(updates.some((file) => file.path === 'patch' && file.kind === 'update'), true, 'a diff-only patch is retained as metadata but is never treated as a workspace path');
    assert.equal(await (await import('node:fs/promises')).readFile(existing, 'utf8'), 'after\n', 'the synthetic stream changes only its fixture workspace');

    const planFallback: AgentUpdate[] = [];
    await session.run('plan result', new AbortController().signal, (update) => planFallback.push(update), undefined, {
      intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' },
    } satisfies TurnOptions);
    assert.equal(planFallback.find((update) => update.id === 'plan-text')?.text, '# result plan');
    assert.deepEqual(sends[1]?.model, { id: 'auto' });

    const blankAssistant: AgentUpdate[] = [];
    await session.run('blank assistant', new AbortController().signal, (update) => blankAssistant.push(update), undefined, {
      intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' },
    } satisfies TurnOptions);
    assert.equal(blankAssistant.some((update) => update.id === 'plan-text'), false, 'whitespace assistant output does not cause a result fallback plan');
  } finally {
    await session.dispose();
  }
});
