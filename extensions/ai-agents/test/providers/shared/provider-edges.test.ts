import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';
import type { AgentSession, AgentUpdate, ChatMessage, PermissionDecision } from '../../../src/types.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function fixture(name: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-edges-'));
  const command = path.join(cwd, name);
  await cp(path.join(__dirname, '../../fixtures', name), command);
  await chmod(command, 0o755);
  return { cwd, command, counter: path.join(cwd, 'counter.log'), async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await check(), true, 'condition was not met before timeout');
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40 && !check(); attempt += 1) await tick();
  assert.equal(check(), true);
}

async function withEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await body(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function lines(file: string, method: string): Promise<number> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line === method).length;
}

function acpOptions(cwd: string, command: string, extra: Record<string, unknown> = {}) {
  return { provider: 'cursor' as const, cwd, model: '', storagePath: cwd, agentPath: command, backend: 'acp' as const, ...extra };
}

function appOptions(cwd: string, command: string, extra: Record<string, unknown> = {}) {
  return { provider: 'codex' as const, cwd, model: 'fixture-model', storagePath: cwd, codexPath: command, backend: 'app-server' as const, ...extra };
}

const interactions = {
  async requestPermission(request: { title: string; kind: string; detail: string }): Promise<PermissionDecision> {
    if (request.title === 'explode') throw new Error('permission failed');
    if (request.title === 'session tool') return 'allow-session';
    if (request.kind === 'shell') return 'allow-once';
    if (request.kind === 'read') return 'allow-session';
    if (request.kind === 'write') return 'deny';
    return 'allow-once';
  },
  async requestPlan() { throw new Error('create_plan must not ask for a plan decision'); },
  async requestAnswers() { return { q1: ['yes'], q2: ['A'] }; },
};

test('ACP create_plan is recorded and cancelled without asking to build', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp-edges.cjs');
  let plans = 0;
  const session = await createCursorAcpSession(acpOptions(cwd, command, {
    interactions: { ...interactions, requestPlan: async () => { plans += 1; return 'accepted'; } },
  }));
  try {
    const updates: AgentUpdate[] = [];
    await session.run('CREATE_PLAN', new AbortController().signal, (update) => updates.push(update));
    const plan = updates.find((update) => update.meta?.type === 'plan')?.meta?.plan;
    assert.equal(plan?.name, 'Hello');
    assert.equal(plan?.overview, 'Add hello');
    assert.equal(plan?.source, 'acp-create-plan');
    assert.deepEqual(plan?.todos, [{ content: 'write', status: 'pending' }]);
    assert.match(updates.map((update) => update.text).join('\n'), /"outcome":"cancelled"/);
    await session.run('CREATE_PHASES', new AbortController().signal, (update) => updates.push(update));
    assert.equal(updates.filter((update) => update.meta?.plan?.markdown === 'phase plan')[0]?.meta?.plan?.todos?.[0]?.content, 'from phase');
    const thrown: AgentUpdate[] = [];
    await session.run('THROW_PLAN', new AbortController().signal, (update) => {
      if (update.meta?.type === 'plan') throw new Error('plan listener failed');
      thrown.push(update);
    });
    assert.match(thrown.map((update) => update.text).join('\n'), /plan listener failed/);
    assert.match(thrown.map((update) => update.text).join('\n'), /"outcome":"cancelled"/);
    assert.equal(plans, 0);
  } finally { await session.dispose(); await cleanup(); }
});

test('ACP permissions, questions, and argv keep the sandbox narrow', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp-edges.cjs');
  const asked: string[] = [];
  const session = await createCursorAcpSession(acpOptions(cwd, command, {
    sandbox: 'disabled', model: 'plain',
    interactions: {
      ...interactions,
      requestPermission: async (request: { title: string; kind: string; detail: string }) => { asked.push(`${request.kind}:${request.detail}`); return interactions.requestPermission(request); },
    },
  }));
  try {
    const updates: AgentUpdate[] = [];
    await session.run('PERMISSIONS', new AbortController().signal, (update) => updates.push(update));
    const decisions = JSON.parse(updates.find((update) => update.text.startsWith('permissions:'))!.text.slice('permissions:'.length)) as { outcome: { optionId: string } }[];
    assert.deepEqual(decisions.map((item) => item.outcome.optionId), ['allow-once', 'allow', 'allow-always', 'allow-once']);
    assert.match(asked[0] ?? '', /shell:a/);
    const write: AgentUpdate[] = [];
    await session.run('PERMISSION_WRITE', new AbortController().signal, (update) => write.push(update));
    assert.match(write.at(-1)?.text ?? '', /"optionId":"reject"/);
    const questions: AgentUpdate[] = [];
    await session.run('ASK', new AbortController().signal, (update) => questions.push(update));
    assert.match(questions.at(-1)?.text ?? '', /"outcome":"answered"/);
    assert.match(questions.at(-1)?.text ?? '', /"questionId":"q1"/);
    const argv: AgentUpdate[] = [];
    await session.run('REPORT_ARGV', new AbortController().signal, (update) => argv.push(update));
    const reported = JSON.parse(argv.filter((update) => update.role === 'assistant').at(-1)!.text) as { argv: string[] };
    const sandbox = reported.argv[reported.argv.indexOf('--sandbox') + 1];
    assert.equal(sandbox, 'disabled');
    assert.equal(reported.argv.includes('danger-full-access'), false);
    const unknown: AgentUpdate[] = [];
    await session.run('UNKNOWN', new AbortController().signal, (update) => unknown.push(update));
    assert.match(unknown.at(-1)?.text ?? '', /unknown:\{\}/);
    const exploded: AgentUpdate[] = [];
    await session.run('THROW_PERMISSION', new AbortController().signal, (update) => exploded.push(update));
    assert.match(exploded.map((update) => update.text).join('\n'), /permission failed/);
    assert.match(exploded.map((update) => update.text).join('\n'), /reject-once/);
  } finally { await session.dispose(); await cleanup(); }
});

test('ACP uses safe permission fallbacks and normalizes malformed question requests', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp-edges.cjs');
  let askedQuestions: { id: string; prompt: string; options: unknown[] }[] | undefined;
  const session = await createCursorAcpSession(acpOptions(cwd, command, {
    interactions: {
      ...interactions,
      requestPermission: async ({ title }: { title: string }) => {
        if (title === 'explode-string') throw 'permission failed string';
        return title === 'deny fallback' ? 'deny' : title === 'session fallback' ? 'allow-session' : 'allow-once';
      },
      requestAnswers: async (request: { questions: { id: string; prompt: string; options: unknown[] }[] }) => { askedQuestions = request.questions; return {}; },
    },
  }));
  try {
    const permissions: AgentUpdate[] = [];
    await session.run('FALLBACK_PERMISSION', new AbortController().signal, (update) => permissions.push(update));
    const selected = JSON.parse(permissions.find((update) => update.text.startsWith('fallback-permissions:'))!.text.slice('fallback-permissions:'.length)) as { outcome: { optionId: string } }[];
    assert.deepEqual(selected.map((item) => item.outcome.optionId), ['reject-once', 'allow-always', 'allow-once']);

    const malformed: AgentUpdate[] = [];
    await session.run('ASK_INVALID', new AbortController().signal, (update) => malformed.push(update));
    assert.deepEqual(askedQuestions, []);
    assert.match(malformed.at(-1)?.text ?? '', /"answers":\[\]/);

    const rejected: AgentUpdate[] = [];
    await session.run('THROW_PERMISSION_NONERROR', new AbortController().signal, (update) => rejected.push(update));
    assert.match(rejected.map((update) => update.text).join('\n'), /permission failed string/);
    assert.match(rejected.map((update) => update.text).join('\n'), /reject-once/);
  } finally { await session.dispose(); await cleanup(); }
});

test('ACP cancels a question request after the host answer handler fails', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp-edges.cjs');
  const session = await createCursorAcpSession(acpOptions(cwd, command, {
    interactions: { ...interactions, requestAnswers: async () => { throw new Error('answer handler failed'); } },
  }));
  try {
    const updates: AgentUpdate[] = [];
    await session.run('ASK_THROW', new AbortController().signal, (update) => updates.push(update));
    assert.equal(updates.find((update) => update.role === 'error')?.text, 'answer handler failed');
    assert.match(updates.at(-1)?.text ?? '', /"outcome":"cancelled"/);
    assert.equal(updates.some((update) => update.text.includes('"outcome":"answered"')), false);
  } finally { await session.dispose(); await cleanup(); }
});

test('ACP shapes, replay, images, and late abort stay on one session', { timeout: 15000 }, async () => {
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-edges.cjs');
  await withEnv({ EDGE_COUNTER: counter, ACP_EDGE: 'replay' }, async () => {
    const session = await createCursorAcpSession(acpOptions(cwd, command, { resumeId: 'saved', mode: 'ask' }));
    const background: AgentUpdate[] = [];
    const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
    try {
      const replay: ChatMessage[] = [];
      await session.loadTranscript?.((message) => replay.push(message));
      assert.equal(replay.some((message) => message.text === 'q1 more'), true);
      assert.equal(replay.some((message) => message.text === 'saved plan'), true);
      assert.equal(replay.some((message) => message.meta?.type === 'thinking'), true);
      assert.equal(replay.some((message) => message.meta?.type === 'image'), true);
      assert.equal(replay.some((message) => message.tool?.line === 1 && message.tool.endLine === 3), true);
      assert.equal(replay.some((message) => message.text === 'direct update payload'), true, 'ACP accepts the notification payload without an update wrapper');
      const live: AgentUpdate[] = [];
      await session.run('SHAPES', new AbortController().signal, (update) => live.push(update));
      assert.equal(live.some((update) => update.meta?.type === 'subagent'), false);
      assert.equal(background.some((update) => update.meta?.subagent?.name === 'custom-agent' && update.meta.subagent.background === true), true);
      assert.equal(background.some((update) => update.meta?.subagent?.status === 'error'), true);
      const retainedTask = background.filter((update) => update.meta?.subagent?.id === 'task-1').at(-1)?.meta?.subagent;
      assert.equal(retainedTask?.status, 'completed', 'an unknown later status must not erase a completed task state');
      assert.equal(retainedTask?.agentId, 'agent-1');
      assert.equal(retainedTask?.model, 'composer');
      assert.equal(retainedTask?.background, true);
      assert.equal(live.some((update) => update.meta?.files?.some((file) => file.kind === 'add' && file.path === 'src/a.ts')), true);
      assert.equal(live.some((update) => update.meta?.files?.some((file) => file.kind === 'rename')), true);
      const generic = live.find((update) => update.id === 'generic-1');
      assert.equal(generic?.text, 'generic output');
      assert.equal(generic?.tool?.name, 'tool');
      const deleted = live.find((update) => update.id === 'delete-1')?.meta?.files?.[0];
      assert.equal(deleted?.kind, 'delete');
      assert.equal(deleted?.previousText, 'gone\n');
      assert.match(live.find((update) => update.meta?.type === 'thinking')?.text ?? '', /one/);
      unsubscribe();
      const after: AgentUpdate[] = [];
      await session.run('SHAPES', new AbortController().signal, (update) => after.push(update));
      assert.equal(after.some((update) => update.meta?.type === 'subagent'), true);
      const listed = await session.listSessions?.();
      assert.equal(listed?.[0]?.title, 'Named');
      assert.equal(listed?.[1]?.title, 's2');
      assert.equal(listed?.some((item) => item.title === 'missing'), false);
      const image: AgentUpdate[] = [];
      await session.run('picture', new AbortController().signal, (update) => image.push(update), { images: [{ mimeType: 'image/png', data: png }] });
      assert.equal(image.some((update) => update.text === 'has-image'), true);
      const controller = new AbortController();
      const late: AgentUpdate[] = [];
      const running = session.run('ABORT_LATE', controller.signal, (update) => late.push(update));
      await until(() => late.some((update) => update.text.includes('started')));
      controller.abort();
      await assert.rejects(running, { name: 'AbortError' });
      assert.equal(late.some((update) => update.text.includes('late after abort')), false);
      for (let attempt = 0; attempt < 40 && await lines(counter, 'session/cancel') < 1; attempt += 1) await tick();
      await tick();
      const stored: string[] = [];
      await session.loadTranscript?.((message) => stored.push(message.text));
      assert.equal(stored.some((text) => text.includes('late after abort')), true);
      assert.equal(await lines(counter, 'session/new'), 0);
      assert.equal(await lines(counter, 'session/load'), 1);
    } finally { unsubscribe(); await session.dispose(); }
  });
  await cleanup();
});

test('ACP startup failures dispose the child and do not widen into a session', { timeout: 15000 }, async () => {
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-edges.cjs');
  try {
    await withEnv({ ACP_EDGE: 'no-session', EDGE_COUNTER: counter }, async () => {
      await assert.rejects(createCursorAcpSession(acpOptions(cwd, command)), /did not return a session id/);
    });
    await withEnv({ ACP_EDGE: 'auth-other' }, async () => {
      await assert.rejects(createCursorAcpSession(acpOptions(cwd, command)), /temporary unavailable/);
    });
    await withEnv({ ACP_EDGE: 'auth-login' }, async () => {
      await assert.rejects(createCursorAcpSession(acpOptions(cwd, command)), /agent login/);
    });
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(createCursorAcpSession(acpOptions(cwd, command, { signal: aborted.signal })), { name: 'AbortError' });
    await withEnv({ ACP_EDGE: 'hang-init' }, async () => {
      const controller = new AbortController();
      const pending = createCursorAcpSession(acpOptions(cwd, command, { signal: controller.signal }));
      await tick();
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    });
    await withEnv({ ACP_EDGE: 'hang-auth', EDGE_COUNTER: counter }, async () => {
      const controller = new AbortController();
      const pending = createCursorAcpSession(acpOptions(cwd, command, { signal: controller.signal }));
      for (let attempt = 0; attempt < 40 && await lines(counter, 'authenticate') !== 1; attempt += 1) await tick();
      assert.equal(await lines(counter, 'authenticate'), 1);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    });
    await withEnv({ ACP_EDGE: 'same-model' }, async () => {
      const session = await createCursorAcpSession(acpOptions(cwd, command, { model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'true' }] }));
      try {
        const updates: AgentUpdate[] = [];
        await session.run('REPORT_ARGV', new AbortController().signal, (update) => updates.push(update));
        assert.equal(JSON.parse(updates.filter((update) => update.role === 'assistant').at(-1)!.text).modelSets, 0);
      } finally { await session.dispose(); }
    });
    await withEnv({ ACP_EDGE: 'switch-auto' }, async () => {
      const session = await createCursorAcpSession(acpOptions(cwd, command, { model: 'auto' }));
      try {
        const updates: AgentUpdate[] = [];
        await session.run('REPORT_ARGV', new AbortController().signal, (update) => updates.push(update));
        assert.equal(JSON.parse(updates.filter((update) => update.role === 'assistant').at(-1)!.text).modelSets >= 1, true);
        await assert.rejects(async () => { await session.setModel!({ provider: 'cursor', cwd, model: 'no-ack' }); }, /did not acknowledge/);
        assert.equal(session.closed, true);
      } finally { await session.dispose(); }
    });
    await withEnv({ ACP_EDGE: 'config-models' }, async () => {
      const session = await createCursorAcpSession(acpOptions(cwd, command, { model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'true' }] }));
      try {
        const updates: AgentUpdate[] = [];
        await session.run('REPORT_ARGV', new AbortController().signal, (update) => updates.push(update));
        assert.equal(JSON.parse(updates.filter((update) => update.role === 'assistant').at(-1)!.text).argv.includes('--model'), true);
      } finally { await session.dispose(); }
    });
  } finally { await cleanup(); }
});

test('ACP defaults to the agent command on PATH and reports session identity updates', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp-edges.cjs');
  const agent = path.join(cwd, 'agent');
  await cp(command, agent);
  await chmod(agent, 0o755);
  await withEnv({ PATH: `${cwd}${path.delimiter}${process.env.PATH ?? ''}` }, async () => {
    const identities: { id: string; title: string; provider: string; cwd?: string }[] = [];
    const session = await createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, backend: 'acp',
      onIdentity: (identity: { id: string; title: string; provider: string; cwd?: string }) => identities.push(identity),
    });
    try {
      assert.equal(session.sessionId, 'acp-edge');
      assert.equal(identities[0]?.title, 'Cursor ACP');
      const updates: AgentUpdate[] = [];
      await session.run('REPORT_ARGV', new AbortController().signal, (update) => updates.push(update));
      const report = JSON.parse(updates.find((update) => update.role === 'assistant')!.text) as { argv: string[] };
      assert.equal(report.argv[1], agent);
      assert.equal(identities.at(-1)?.title, 'REPORT_ARGV');
      assert.equal(identities.at(-1)?.id, session.sessionId);
    } finally { await session.dispose(); }
  });
  await cleanup();
});

test('ACP plan text is kept only when no structured plan arrived, and disconnects do not open another session', { timeout: 15000 }, async () => {
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-edges.cjs');
  await withEnv({ EDGE_COUNTER: counter }, async () => {
    const session = await createCursorAcpSession(acpOptions(cwd, command));
    try {
      const plain = await createCursorAcpSession(acpOptions(cwd, command));
      try {
        const denied: AgentUpdate[] = [];
        await plain.run('ASK', new AbortController().signal, (update) => denied.push(update));
        assert.match(denied.at(-1)?.text ?? '', /"answers":\[\]/);
        const quiet: AgentUpdate[] = [];
        await plain.run('PERMISSION_WRITE', new AbortController().signal, (update) => quiet.push(update));
        assert.match(quiet.at(-1)?.text ?? '', /reject/);
      } finally { await plain.dispose(); }
      const planned: AgentUpdate[] = [];
      await session.run('PLAN_TEXT', new AbortController().signal, (update) => planned.push(update), undefined, { intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' } });
      assert.equal(planned.some((update) => update.meta?.plan?.source === 'assistant-text' && update.meta.plan.markdown === 'plan from text'), true);
      const seen: AgentUpdate[] = [];
      await session.run('PLAN_SEEN', new AbortController().signal, (update) => seen.push(update), undefined, { intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' } });
      assert.equal(seen.filter((update) => update.meta?.type === 'plan').length, 1);
      assert.equal(await lines(counter, 'session/new'), 2);
      await assert.rejects(session.run('DISCONNECT', new AbortController().signal, () => {}), /exited|起動できません/);
      assert.equal(session.closed, true);
      const started = Date.now();
      await assert.rejects(session.run('again', new AbortController().signal, () => {}), /closed|exited/);
      assert.ok(Date.now() - started < 1000);
      assert.equal(await lines(counter, 'session/new'), 2);
    } finally { await session.dispose(); }
  });
  await cleanup();
});

test('App Server events, approvals, and questions keep sandbox and approval decisions', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server-edges.cjs');
  const session = await createCodexAppServerSession(appOptions(cwd, command, {
    approval: 'on-request', network: true, webSearch: 'cached', additionalDirectories: ['/tmp/extra'],
    modelParams: [{ id: 'modelReasoningEffort', value: 'low' }],
    interactions: {
      requestPermission: async (request: { title: string; kind: string; detail: string }) => request.kind === 'write' ? 'deny' : request.kind === 'network' ? 'allow-session' : 'allow-once',
      requestPlan: async () => 'rejected',
      requestAnswers: async () => ({ q1: ['Yes'], q2: ['A'] }),
    },
  }));
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    const live: AgentUpdate[] = [];
    await session.run('EVENTS', new AbortController().signal, (update) => live.push(update));
    const text = live.map((update) => update.text).join('\n');
    assert.equal(text.includes('secret'), false);
    assert.equal(text.includes('hidden child'), false);
    assert.match(text, /ls/);
    assert.equal(live.some((update) => update.meta?.files?.some((file) => file.path.endsWith('to.ts') && file.oldPath?.endsWith('from.ts'))), true);
    assert.equal(live.some((update) => update.meta?.plan?.markdown === '# Plan'), true);
    assert.equal(live.some((update) => update.meta?.type === 'todo'), true);
    assert.equal(live.some((update) => update.id === 'todo-malformed' && update.meta?.type !== 'todo'), true, 'a malformed todo payload is ignored without inventing steps');
    assert.equal(live.some((update) => update.id === 'plan' && update.meta?.todos?.length === 0), true, 'a malformed plan notification normalizes to an empty todo snapshot');
    assert.equal(live.some((update) => update.meta?.type === 'thinking'), true);
    assert.equal(live.some((update) => update.final && update.text === 'final text'), true);
    assert.match(text, /visible/);
    assert.match(text, /protocol/);
    assert.equal(live.some((update) => update.role === 'tool' && update.id === 'item' && update.text === 'tool: fallback tool' && update.tool?.name === 'tool'), true, 'unknown item types retain their text with the generic tool fallback');
    assert.equal(live.some((update) => update.meta?.subagent?.id === 'thread-1'), false, 'the parent thread cannot become its own child agent');
    assert.equal(live.some((update) => update.meta?.usage?.inputTokens === 4 && update.meta.usage.cacheWriteInputTokens === 1), true);
    const child = background.filter((update) => update.meta?.subagent?.id === 'child-1').map((update) => update.meta!.subagent!.status);
    assert.equal(child.includes('error'), true);
    assert.equal(child.at(-1), 'completed');
    assert.equal(background.some((update) => update.meta?.type === 'files' && update.meta.files?.some((file) => file.path === 'child.ts')), true);
    assert.equal(live.some((update) => update.id === 'file-malformed' && !update.meta?.files), true, 'a non-array file payload does not become a fabricated file change');
    assert.equal((await session.listBackgroundTerminals?.())?.length, 0);
    const partialUsage: AgentUpdate[] = [];
    await session.run('USAGE_PARTIAL', new AbortController().signal, (update) => partialUsage.push(update));
    const partial = partialUsage.filter((update) => update.meta?.type === 'usage').map((update) => update.meta!.usage!);
    assert.deepEqual(partial.map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens]), [[0, 3], [4, 0]]);
    assert.equal(Object.hasOwn(partial[0]!, 'contextWindow'), true);
    assert.equal(partial[0]?.contextTokens, undefined);
    const approvals: AgentUpdate[] = [];
    await session.run('APPROVALS', new AbortController().signal, (update) => approvals.push(update));
    const decided = JSON.parse(approvals.find((update) => update.text.startsWith('['))!.text) as { decision?: string }[];
    assert.deepEqual(decided.map((item) => item.decision), ['accept', 'decline', 'acceptForSession', undefined]);
    const answers: AgentUpdate[] = [];
    await session.run('QUESTIONS', new AbortController().signal, (update) => answers.push(update));
    assert.match(answers.map((update) => update.text).join('\n'), /"q1":\{"answers":\["Yes"\]\}/);
    assert.equal(await session.steer?.('more'), true);
    assert.equal(await session.rateLimits?.(), 'Codex 7% of the current window');
    assert.match(await session.instructions?.() ?? '', /AGENTS.md: AGENTS.md/);
    assert.match(await session.instructions?.() ?? '', /nested/);
    assert.match(await session.instructions?.() ?? '', /MCP: srv/);
    await session.compact?.();
    const review: AgentUpdate[] = [];
    await session.review?.('base', (update) => review.push(update), new AbortController().signal);
    assert.equal(review.some((update) => update.text.includes('baseBranch')), true);
    await session.review?.('uncommitted', (update) => review.push(update), new AbortController().signal);
    assert.equal(review.some((update) => update.text.includes('uncommittedChanges')), true);
  } finally { unsubscribe(); await session.dispose(); await cleanup(); }
});

test('App Server plan mode stays read-only and a reported sandbox is not widened', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server-edges.cjs');
  await withEnv({ APP_EDGE: 'external' }, async () => {
    const session = await createCodexAppServerSession(appOptions(cwd, command, { sandbox: 'read-only', approval: 'never', network: false }));
    try {
      for (const mode of ['plan', 'agent'] as const) {
        const updates: AgentUpdate[] = [];
        await session.run('ECHO_POLICY', new AbortController().signal, (update) => updates.push(update), undefined, { intent: mode === 'plan' ? 'plan' : 'build', mode, selection: { provider: 'codex', cwd, model: 'fixture-model' } });
        const actual = JSON.parse(updates.filter((update) => update.role === 'assistant').at(-1)!.text) as { sandbox: { type: string; networkAccess?: boolean }; approval: string };
        if (mode === 'plan') assert.deepEqual(actual, { sandbox: { type: 'readOnly', networkAccess: false }, approval: 'never' });
        else {
          assert.equal(actual.sandbox.type, 'externalSandbox');
          assert.equal(actual.approval, 'never');
          assert.equal(JSON.stringify(actual).includes('dangerFullAccess'), false);
        }
      }
    } finally { await session.dispose(); }
  });
  const bare = await createCodexAppServerSession({ provider: 'codex', cwd, model: '', storagePath: cwd, codexPath: command, backend: 'app-server' });
  try {
    assert.equal(await bare.steer?.('early'), false);
    const updates: AgentUpdate[] = [];
    await bare.run('REPORT_START', new AbortController().signal, (update) => updates.push(update));
    const started = JSON.parse(updates.filter((update) => update.role === 'assistant').at(-1)!.text) as { model?: string; sandbox: string; approvalPolicy: string };
    assert.equal(started.model, undefined);
    assert.equal(started.sandbox, 'workspace-write');
    assert.equal(started.approvalPolicy, 'never');
    const image: AgentUpdate[] = [];
    await bare.run('IMAGE', new AbortController().signal, (update) => image.push(update), { images: [{ mimeType: 'image/png', data: png }] });
    assert.match(image.map((update) => update.text).join('\n'), /localImage/);
  } finally { await bare.dispose(); await cleanup(); }
});

test('App Server uses top-level thread identity and model fallbacks and keeps a started turn id', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server-edges.cjs');
  await withEnv({ APP_EDGE: 'thread-fallback' }, async () => {
    const identities: { id: string; title: string; provider: string; cwd?: string }[] = [];
    const session = await createCodexAppServerSession(appOptions(cwd, command, {
      model: '',
      onIdentity: (identity: { id: string; title: string; provider: string; cwd?: string }) => identities.push(identity),
    }));
    try {
      assert.equal(session.sessionId, 'fallback-thread');
      assert.equal(identities[0]?.id, 'fallback-thread');
      assert.equal(identities[0]?.provider, 'codex');
      assert.equal(identities[0]?.cwd, cwd);

      const reported: AgentUpdate[] = [];
      await session.run('REPORT_TURN', new AbortController().signal, (update) => reported.push(update));
      const start = JSON.parse(reported.find((update) => update.role === 'assistant')!.text) as { model: string };
      assert.equal(start.model, 'reported-model');

      await session.run('FALLBACK_TURN', new AbortController().signal, () => {});
      assert.equal(session.latestBackendTurnId?.(), 'fallback-turn');
      assert.equal(identities.at(-1)?.title, 'FALLBACK_TURN');
    } finally {
      await session.dispose();
      await cleanup();
    }
  });
});

test('App Server history, forks, and terminal lists reject unverifiable or repeated cursors', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server-edges.cjs');
  try {
    await withEnv({ APP_EDGE: 'history' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command, { resumeId: 'history' }));
      try {
        const replay: ChatMessage[] = [];
        await session.loadTranscript?.((message) => replay.push(message));
        assert.equal(replay.filter((message) => message.meta?.subagent?.id === 'child-a').length, 1);
        assert.equal(replay.find((message) => message.role === 'user')?.text, 'question');
        assert.equal(replay.find((message) => message.role === 'error')?.text, 'bad');
        assert.equal(replay.find((message) => message.final)?.text, 'answer');
        assert.equal(replay.some((message) => message.text === 'ab'), true);
      } finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'history-root' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command, { resumeId: 'root' }));
      try {
        const replay: ChatMessage[] = [];
        await session.loadTranscript?.((message) => replay.push(message));
        assert.equal(replay.some((message) => message.text === 'question'), true);
      } finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'history-shape' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command, { resumeId: 'history-shape' }));
      try {
        const replay: ChatMessage[] = [];
        await session.loadTranscript?.((message) => replay.push(message));
        assert.equal(replay.some((message) => message.role === 'user' && message.text === 'saved without a turn id' && message.backendTurnId === ''), true);
        assert.deepEqual(replay.find((message) => message.meta?.subagent?.id === 'child-without-metadata')?.meta?.subagent, {
          id: 'child-without-metadata', name: 'Subagent', status: 'unknown', background: 'unknown',
        });
        assert.equal(replay.length, 2, 'turns with malformed item collections are ignored');
      } finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'pages' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try {
        const replay: ChatMessage[] = [];
        await session.loadTranscript?.((message) => replay.push(message));
        assert.deepEqual(replay.map((message) => message.text), ['one', 'two']);
        assert.equal(replay[1]?.final, true);
      } finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'read-fallback' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try {
        const replay: ChatMessage[] = [];
        await session.loadTranscript?.((message) => replay.push(message));
        assert.equal(replay[0]?.text, 'from read');
      } finally { await session.dispose(); }
    });
    const session = await createCodexAppServerSession(appOptions(cwd, command));
    try {
      assert.equal(session.rewindUnsupportedReason?.(), undefined);
      assert.equal(await session.forkBeforeTurn?.('turn-b'), 'thread-2');
      session.activateFork?.('thread-2');
      assert.equal(session.sessionId, 'thread-2');
      assert.equal(session.latestBackendTurnId?.(), undefined);
      assert.throws(() => session.activateFork?.('thread-9'), /did not create/);
      assert.equal(await session.fork?.(), 'thread-2');
    } finally { await session.dispose(); }
    await withEnv({ APP_EDGE: 'legacy' }, async () => {
      const legacy = await createCodexAppServerSession(appOptions(cwd, command));
      try {
        assert.match(legacy.rewindUnsupportedReason?.() ?? '', /paginated history/);
        await assert.rejects(async () => { await legacy.forkBeforeTurn?.('turn-a'); }, /does not support/);
      } finally { await legacy.dispose(); }
    });
    for (const [edge, pattern] of [['mismatch', /does not end/], ['no-branch', /distinct/], ['same-branch', /distinct/], ['bad-page', /verifiable/], ['missing-turn-id', /without an id/], ['repeat-cursor', /repeated a history cursor/]] as const) {
      await withEnv({ APP_EDGE: edge }, async () => {
        const broken = await createCodexAppServerSession(appOptions(cwd, command));
        try { await assert.rejects(async () => { await broken.forkBeforeTurn?.('turn-b'); }, pattern); }
        finally { await broken.dispose(); }
      });
    }
  } finally { await cleanup(); }
});

test('App Server cancellation, disconnect, and terminal errors leave no extra session', { timeout: 20000 }, async () => {
  const { cwd, command, counter, cleanup } = await fixture('mock-app-server-edges.cjs');
  try {
    await withEnv({ EDGE_COUNTER: counter }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      const background: AgentUpdate[] = [];
      const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
      try {
        assert.equal(await session.forkBeforeTurn?.('turn-b'), 'thread-2');
        const controller = new AbortController();
        const waiting: AgentUpdate[] = [];
        const hanging = session.run('HANG', controller.signal, (update) => waiting.push(update));
        await waitFor(() => waiting.some((update) => update.text.includes('waiting')));
        await assert.rejects(async () => { await session.forkBeforeTurn?.('hang-turn'); }, /still running/);
        assert.throws(() => session.activateFork?.('thread-2'), /must finish/);
        controller.abort();
        await assert.rejects(hanging, { name: 'AbortError' });
        hanging.catch(() => undefined);
        const aborting = new AbortController();
        const pending = session.run('ABORT_DURING_REQUEST', aborting.signal, () => {});
        await waitFor(async () => await lines(counter, 'turn/start') >= 2);
        aborting.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        await assert.rejects(async () => { await session.run('FAIL_RETRY', new AbortController().signal, () => {}); }, /hard failure/);
        await assert.rejects(session.run('FAIL_EMPTY', new AbortController().signal, () => {}), /Codex turn failed/);
        await assert.rejects(session.run('INTERRUPTED', new AbortController().signal, () => {}), { name: 'AbortError' });
        await session.run('BARE_COMPLETE', new AbortController().signal, () => {});
        const usage: AgentUpdate[] = [];
        await session.run('USAGE_TURN', new AbortController().signal, (update) => usage.push(update));
        assert.equal(usage.some((update) => update.meta?.usage?.inputTokens === 2), true);
        const late: AgentUpdate[] = [];
        await session.run('LATE_AFTER', new AbortController().signal, (update) => late.push(update));
        assert.equal(late.some((update) => update.text === 'late answer'), false);
        await session.listBackgroundTerminals?.();
        assert.equal(background.some((update) => update.text === 'late answer'), true);
        const before = background.length;
        unsubscribe();
        await session.listBackgroundTerminals?.();
        assert.equal(background.length, before);
        await assert.rejects(session.run('DISCONNECT', new AbortController().signal, () => {}), /exited/);
        assert.equal(session.closed, true);
        const started = Date.now();
        await assert.rejects(session.run('again', new AbortController().signal, () => {}), /closed|exited/);
        assert.ok(Date.now() - started < 1000);
        assert.equal(await lines(counter, 'thread/start'), 1);
      } finally { unsubscribe(); await session.dispose(); }
    });
    for (const [edge, pattern] of [['repeat-cursor', /repeated a cursor/], ['bad-terminals', /did not contain an array/]] as const) {
      await withEnv({ APP_EDGE: edge }, async () => {
        const session = await createCodexAppServerSession(appOptions(cwd, command));
        try { await assert.rejects(async () => { await session.listBackgroundTerminals?.(); }, pattern); }
        finally { await session.dispose(); }
      });
    }
    await withEnv({ APP_EDGE: 'paged-ok' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.deepEqual((await session.listBackgroundTerminals?.())?.map((row) => row.processId), ['proc-1', 'proc-2']); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'terminals-key' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.deepEqual((await session.listBackgroundTerminals?.())?.map((row) => row.processId), ['proc-2']); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'threads-key' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try {
        const listed = await session.listSessions?.();
        assert.equal(listed?.[0]?.title, 'Preview');
        assert.equal(listed?.length, 1);
      } finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'rate-empty' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.match(await session.rateLimits?.() ?? '', /unavailable/); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'skills-fail' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.match(await session.instructions?.() ?? '', /Skills: none/); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'mcp-bad' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.match(await session.instructions?.() ?? '', /MCP: none/); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'no-sources' }, async () => {
      const session = await createCodexAppServerSession(appOptions(cwd, command));
      try { assert.match(await session.instructions?.() ?? '', /AGENTS.md: none reported/); }
      finally { await session.dispose(); }
    });
    await withEnv({ APP_EDGE: 'no-thread' }, async () => {
      await assert.rejects(createCodexAppServerSession(appOptions(cwd, command)), (error: Error) => {
        assert.match(error.message, /did not return a thread id/);
        assert.equal(error.message.includes('起動できません'), false);
        return true;
      });
    });
    await assert.rejects(createCodexAppServerSession(appOptions(cwd, path.join(cwd, 'missing-codex'))), /起動できません/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(createCodexAppServerSession(appOptions(cwd, command, { signal: aborted.signal })), { name: 'AbortError' });
    const quiet = await createCodexAppServerSession(appOptions(cwd, command));
    try {
      const updates: AgentUpdate[] = [];
      await quiet.run('APPROVALS', new AbortController().signal, (update) => updates.push(update));
      assert.match(updates.map((update) => update.text).join('\n'), /decline/);
    } finally { await quiet.dispose(); }
  } finally { await cleanup(); }
});
