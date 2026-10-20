import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { createManagedSession } from '../../src/providers/managed-session.js';
import { createSession } from '../../src/providers/index.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import type { AgentUpdate } from '../../src/types.js';

const fixture = path.resolve('test/fixtures/mock-app-server.cjs');
async function waitFor(file: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await readFile(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic acceptance gate was not reached.');
}
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
}
for (const mode of ['agent', 'plan'] as const) test(`managed ${mode}: client process death retains accepted execution once`, { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd, ownerKey: 'isolated-conversation', model: 'gpt-6-luna', codexPath: fixture, mode };
  const config = path.join(cwd, 'config.json');
  await writeFile(config, JSON.stringify(options));
  const first = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/managed-host.mjs', config, 'start'], { stdio: 'ignore' });
  const firstExit = exited(first);
  try {
    await waitFor(path.join(cwd, 'managed-dispatches.txt'));
    first.kill('SIGKILL'); await firstExit;
    await writeFile(path.join(cwd, 'managed-release'), 'release');
    const second = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/managed-host.mjs', config, 'recover'], { stdio: 'inherit' });
    assert.equal(await exited(second), 0);
    assert.equal(await readFile(path.join(cwd, 'managed-dispatches.txt'), 'utf8'), 'managed-held-turn\n');
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'managed-recovered.txt'), 'utf8')), { sessionId: 'thread-1', turnId: 'managed-held-turn' });
    if (mode === 'agent') assert.equal(await readFile(path.join(cwd, 'managed-result.txt'), 'utf8'), 'once\n');
  } finally { first.kill(); await rm(cwd, { recursive: true, force: true }); }
});

test('managed reconnect rejects a different session and never submits a missing run', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd, ownerKey: 'isolated-conversation', model: 'gpt-6-luna', codexPath: fixture };
  let session = await createManagedSession(options);
  try {
    await session.detach!();
    await assert.rejects(createManagedSession({ ...options, resumeId: 'different-thread' }), /does not match/);
    session = await createManagedSession({ ...options, resumeId: 'thread-1' });
    const updates: AgentUpdate[] = [];
    assert.equal(await session.recoverRun!('nonexistent', new AbortController().signal, (u) => updates.push(u), () => assert.fail()), false);
    assert.equal(updates.length, 0);
  } finally { await session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('Darwin App Server sessions with an owner key use the managed owner', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const session = await createSession({ provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'factory-route', model: 'gpt-6-luna', codexPath: fixture });
  try {
    assert.equal(typeof session.recoverRun, 'function');
    assert.equal(session.sessionId, 'thread-1');
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed startup failure can retry initialization without retaining a rejected owner', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const launcher = path.join(cwd, 'one-shot.cjs');
  await writeFile(launcher, `const fs = require('node:fs'); const {spawnSync} = require('node:child_process'); if (!fs.existsSync('attempted')) { fs.writeFileSync('attempted', '1'); process.exit(73); } const child = spawnSync(process.execPath, [${JSON.stringify(fixture)}, ...process.argv.slice(2)], {stdio:'inherit'}); process.exit(child.status ?? 1);`);
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd, ownerKey: 'isolated-retry', model: 'gpt-6-luna', codexPath: launcher };
  let session: Awaited<ReturnType<typeof createManagedSession>> | undefined;
  try {
    await assert.rejects(createManagedSession(options), /exited|起動/);
    session = await createManagedSession(options);
    assert.equal(session.sessionId, 'thread-1');
    assert.equal(await session.recoverRun!('never-dispatched', new AbortController().signal, () => assert.fail(), () => assert.fail()), false);
  } finally { await session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('managed session forwards supported controls through its owner', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const options: SessionOptions = {
    provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'controls', model: 'gpt-6-luna', codexPath: fixture,
  };
  const session = await createManagedSession(options);
  try {
    await session.setMode?.('plan');
    assert.equal(await session.steer?.('follow up'), false, 'a finished owner has no turn to steer');
    assert.equal((await session.listSessions?.())?.[0]?.id, 'thread-1');
    assert.match(await session.rateLimits?.() ?? '', /12%/);
    assert.match(await session.instructions?.() ?? '', /fixture-skill/);
    await session.compact?.();
    await session.review?.('uncommitted', () => {}, new AbortController().signal);
    await session.terminateBackgroundTerminal?.('missing');
    await assert.rejects(session.interruptBackgroundTerminal?.('missing') ?? Promise.resolve(), /ターミナル|terminal/i);
    const forkId = await session.fork?.();
    assert.match(forkId ?? '', /^thread-/);
    await assert.rejects(session.forkBeforeTurn?.('missing') ?? Promise.resolve(), /no longer present/);
    session.activateFork?.('not-owned');
  } finally {
    await session.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner relays approval requests and keeps the accepted run recoverable', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const requests: string[] = [];
  const session = await createManagedSession({
    provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'approval', model: 'gpt-6-luna', codexPath: fixture,
    interactions: {
      async requestPermission(request) { requests.push(request.id); return 'allow-once'; },
      async requestPlan() { return 'accepted'; },
      async requestAnswers(request) { requests.push(request.id); return { choice: ['safe'] }; },
    },
  });
  try {
    const updates: AgentUpdate[] = [];
    await session.run('NEED_APPROVAL', new AbortController().signal, (update) => updates.push(update), undefined, {
      executionId: 'approval-run', intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-6-luna' },
    });
    assert.deepEqual(requests, ['approval-1']);
    assert.ok(updates.some((update) => update.text.includes('approved:accept')));
    let attached = false;
    assert.equal(await session.recoverRun?.('approval-run', new AbortController().signal, () => {}, () => { attached = true; }), true);
    assert.equal(attached, true);
    const answerUpdates: AgentUpdate[] = [];
    await session.run('NEED_ANSWERS', new AbortController().signal, (update) => answerUpdates.push(update), undefined, {
      executionId: 'answers-run', intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-6-luna' },
    });
    assert.deepEqual(requests, ['approval-1', 'question-1']);
    assert.ok(answerUpdates.some((update) => update.text.includes('safe')));
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner refuses invalid and competing socket clients', { skip: process.platform !== 'darwin', timeout: 8_000 }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'socket-security', model: 'gpt-6-luna', codexPath: fixture };
  let session = await createManagedSession(options);
  const key = createHash('sha256').update(JSON.stringify([cwd, await realpath(cwd), options.ownerKey])).digest('hex').slice(0, 40);
  const root = path.join('/private/tmp', `ai-agents-owner-${process.getuid?.()}-${key}`);
  const socketPath = path.join(root, 'control.sock');
  const token = await readFile(path.join(root, 'token'), 'utf8');
  const open = async () => {
    const socket = connect(socketPath);
    await once(socket, 'connect');
    return socket;
  };
  try {
    for (const hello of [{ id: 1, token: 'wrong' }, { id: 1, token }]) {
      const socket = await open();
      const closed = once(socket, 'close');
      socket.write(`${JSON.stringify(hello)}\n`);
      await closed;
    }
    const oversized = await open();
    const rejected = once(oversized, 'close');
    oversized.write('x'.repeat(1100));
    await rejected;

    await session.detach?.();
    const socket = await open();
    let output = '';
    socket.on('data', (chunk) => { output += String(chunk); });
    socket.write(`${JSON.stringify({ id: 1, token })}\n`);
    while (!output.includes('\n')) await new Promise((resolve) => setTimeout(resolve, 5));
    socket.write(`${JSON.stringify({ id: 2, method: 'unsupported' })}\n`);
    while (!output.includes('Unsupported managed operation.')) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(output, /Unsupported managed operation/);
    socket.write(`${JSON.stringify({ id: 3, method: 'initialize', args: { provider: 'cursor', backend: 'app-server' } })}\n`);
    while (!output.includes('Unsupported managed backend.')) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(output, /Unsupported managed backend/);
    const closed = once(socket, 'close');
    socket.write('{invalid json\n');
    await closed;
    session = await createManagedSession(options);
  } finally {
    await session.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner rejects replayed run ids and cancels a live execution', { skip: process.platform !== 'darwin', timeout: 8_000 }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const session = await createManagedSession({ provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'run-ids', model: 'gpt-6-luna', codexPath: fixture });
  const turn = (executionId: string) => ({ executionId, intent: 'chat' as const, mode: 'agent' as const,
    selection: { provider: 'codex' as const, cwd, model: 'gpt-6-luna' } });
  try {
    await assert.rejects(session.run('hello', new AbortController().signal, () => {}, undefined,
      { ...turn('missing'), executionId: undefined }), /stable execution id/);
    await session.run('hello', new AbortController().signal, () => {}, undefined, turn('first'));
    await session.run('hello', new AbortController().signal, () => {}, undefined, turn('first'));
    await session.run('hello', new AbortController().signal, () => {}, undefined, turn('second'));
    await assert.rejects(session.run('hello', new AbortController().signal, () => {}, undefined, turn('first')), /already accepted/);

    const abort = new AbortController();
    const running = session.run('MANAGED_RELOAD_GATE', abort.signal, () => {}, undefined, turn('live'));
    await waitFor(path.join(cwd, 'managed-dispatches.txt'));
    await assert.rejects(session.run('another', new AbortController().signal, () => {}, undefined, turn('overlapping')), /still running/);
    abort.abort();
    await assert.rejects(running, { name: 'AbortError' });
    await writeFile(path.join(cwd, 'managed-release'), 'release');
  } finally {
    await session.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner fails a run whose retained output exceeds its recovery budget', { skip: process.platform !== 'darwin', timeout: 12_000 }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const session = await createManagedSession({ provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'output-budget', model: 'gpt-6-luna', codexPath: fixture });
  try {
    await assert.rejects(session.run('OVERSIZED_MANAGED_OUTPUT', new AbortController().signal, () => {}, undefined, {
      executionId: 'oversized-run', intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-6-luna' },
    }), /Retained execution output exceeded the 16 MB recovery limit/);
  } finally {
    await session.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner reports a backend failure without treating it as cancellation', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const session = await createManagedSession({ provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'backend-failure', model: 'gpt-6-luna', codexPath: fixture });
  try {
    await assert.rejects(session.run('FAIL_TURN', new AbortController().signal, () => {}, undefined, {
      executionId: 'failed-run', intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-6-luna' },
    }), /boom|failed/);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed owner replays an unanswered approval after client reconnection', { skip: process.platform !== 'darwin', timeout: 8_000 }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-test-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'pending-approval', model: 'gpt-6-luna', codexPath: fixture };
  let session = await createManagedSession(options);
  const pending = session.run('NEED_APPROVAL', new AbortController().signal, () => {}, undefined, {
    executionId: 'pending-approval-run', intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-6-luna' },
  });
  try {
    await waitFor(path.join(cwd, 'approval-requested'));
    await session.detach?.();
    await assert.rejects(pending, /disconnected|closed/);
    let approvals = 0;
    session = await createManagedSession({ ...options, interactions: {
      async requestPermission() { approvals += 1; return 'allow-once'; },
      async requestPlan() { return 'accepted'; },
      async requestAnswers() { return {}; },
    } });
    assert.equal(await session.recoverRun?.('pending-approval-run', new AbortController().signal, () => {}, () => {}), true);
    assert.equal(approvals, 1);
  } finally {
    await session.dispose().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});
