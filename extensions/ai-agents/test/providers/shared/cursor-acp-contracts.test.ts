import assert from 'node:assert/strict';

import { chmod, cp, mkdtemp, readFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

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
  const { cwd, command, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
  const { cwd, command, counter, cleanup } = await fixture('mock-acp-scenarios.cjs');
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
