import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SDKMessage } from '@cursor/sdk';
import type { createSession } from '../../../src/providers/index.js';
import type { AgentUpdate, SessionSummary, TurnOptions } from '../../../src/types.js';

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;
type CursorSdk = Awaited<ReturnType<Loaders['cursor']>>;
type CodexSdk = Awaited<ReturnType<Loaders['codex']>>;

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

test('Codex retargeting to an empty model and empty prompt keeps SDK defaults and a stable identity', async (t) => {
  const cwd = await directory(t);
  const resumed: Array<{ id: string; options: Record<string, unknown> }> = [];
  const identities: SessionSummary[] = [];
  const thread = {
    id: 'saved-thread',
    async runStreamed() {
      return { events: (async function* () { yield { type: 'thread.started', thread_id: 'saved-thread' }; })() };
    },
  };
  class Codex {
    constructor(_options: unknown) {}
    startThread(_options: unknown) { throw new Error('resume path must not start'); }
    resumeThread(id: string, options: Record<string, unknown>) { resumed.push({ id, options }); return thread; }
  }
  const sdk = { Codex } as unknown as CodexSdk;
  const loaders: Loaders = { codex: async () => sdk, cursor: async () => { throw new Error('Cursor not selected'); } };
  const { createSession } = await import('../../../src/providers/index.js');
  const session = await createSession({
    provider: 'codex', cwd, model: 'gpt-test', storagePath: cwd, resumeId: 'saved-thread',
    onIdentity: (identity) => identities.push(identity),
  }, loaders, true);
  try {
    session.setModel!({ provider: 'codex', cwd, model: '' });
    assert.equal(resumed.length, 2, 'the initial thread is resumed once, then retargeted');
    assert.equal(resumed.at(-1)?.id, 'saved-thread');
    assert.equal(resumed.at(-1)?.options.model, undefined, 'an empty selection restores the SDK default model');
    await session.run('', new AbortController().signal, () => {});
    assert.equal(identities[0]?.title, 'Codex', 'an empty prompt still gives the restored thread a useful identity');
  } finally {
    await session.dispose();
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

test('Codex SDK enriches rename and update metadata from tracked baselines and preserves supplied fallback text', async (t) => {
  const cwd = await directory(t);
  await writeFile(path.join(cwd, 'old.txt'), 'old source\n');
  await writeFile(path.join(cwd, 'ordinary.txt'), 'ordinary before\n');
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd });
  execFileSync('git', ['add', 'old.txt', 'ordinary.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'synthetic codex baseline', '--quiet'], { cwd });

  const thread = {
    id: 'codex-file-thread',
    async runStreamed() {
      writeFileSync(path.join(cwd, 'new.txt'), 'new target\n');
      writeFileSync(path.join(cwd, 'ordinary.txt'), 'ordinary after\n');
      writeFileSync(path.join(cwd, 'fallback.txt'), 'fallback after\n');
      const events = (async function* () {
        yield { type: 'thread.started', thread_id: 'codex-file-thread' };
        yield { type: 'item.completed', item: { id: 'rename', type: 'file_change', status: 'completed', changes: [
          { path: 'old.txt', kind: { type: 'update', movePath: 'new.txt' }, diff: '-old source\n+new target\n' },
          { path: 'ordinary.txt', kind: 'update', diff: '-ordinary before\n+ordinary after\n' },
          { path: 'fallback.txt', kind: { type: 'rename', movePath: 'missing-source.txt' }, previousText: 'fallback before\n', diff: '-fallback before\n+fallback after\n' },
        ] } };
      })();
      return { events };
    },
  };
  class Codex {
    constructor(_options: unknown) {}
    startThread(_options: unknown) { return thread; }
    resumeThread(_id: string, _options: unknown) { return thread; }
  }
  const sdk = { Codex } as unknown as CodexSdk;
  const loaders: Loaders = { codex: async () => sdk, cursor: async () => { throw new Error('Cursor not selected'); } };
  const { createSession } = await import('../../../src/providers/index.js');
  const session = await createSession({ provider: 'codex', cwd, model: '', storagePath: path.join(cwd, 'store') }, loaders, true);
  try {
    const updates: AgentUpdate[] = [];
    await session.run('inspect synthetic changes', new AbortController().signal, (update) => updates.push(update));
    const files = updates.find((update) => update.id === 'rename')?.meta?.files ?? [];
    const renamed = files.find((file) => file.path === 'new.txt');
    assert.equal(renamed?.kind, 'rename');
    assert.equal(renamed?.oldPath, 'old.txt');
    assert.equal(renamed?.previousText, 'old source\n');
    assert.equal(renamed?.previousMode, 0o644);
    assert.equal(renamed?.additions, 1);
    assert.equal(renamed?.deletions, 1);

    const ordinary = files.find((file) => file.path === 'ordinary.txt');
    assert.equal(ordinary?.previousText, 'ordinary before\n', 'updates without oldPath look up their own tracked path');
    assert.equal(ordinary?.previousMode, 0o644);
    const fallback = files.find((file) => file.path === 'fallback.txt');
    assert.equal(fallback?.oldPath, 'missing-source.txt');
    assert.equal(fallback?.previousText, 'fallback before\n', 'server-supplied old text is preserved when Git has no source object');
    assert.equal(fallback?.previousMode, undefined);
  } finally {
    await session.dispose();
  }
});
