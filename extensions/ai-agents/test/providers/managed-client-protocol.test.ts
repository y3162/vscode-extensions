import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { test } from 'node:test';
import { createManagedSession, managedWorkerEntry } from '../../src/providers/managed-session.js';
import type { SessionOptions } from '../../src/providers/session-options.js';

type Request = { id: number; method: string; args?: unknown };

async function fakeOwner(onRequest: (request: Request, socket: Socket) => void) {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-client-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'fake-owner', model: 'fixture' };
  const key = createHash('sha256').update(JSON.stringify([cwd, await realpath(cwd), options.ownerKey])).digest('hex').slice(0, 40);
  const root = path.join('/private/tmp', `ai-agents-owner-${process.getuid?.()}-${key}`);
  await mkdir(root, { mode: 0o700 });
  await writeFile(path.join(root, 'token'), 'test-token', { mode: 0o600 });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    createInterface({ input: socket }).on('line', (line) => onRequest(JSON.parse(line) as Request, socket));
  });
  await new Promise<void>((resolve) => server.listen(path.join(root, 'control.sock'), resolve));
  return { cwd, root, options, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  } };
}

function reply(socket: Socket, id: number, value: unknown, extra: Record<string, unknown> = {}) {
  socket.write(`${JSON.stringify({ id, value, ...extra })}\n`);
}

const identity = { id: 'fake-thread', title: 'Fake owner' };

test('managed worker path resolves packaged, compiled and distribution layouts', () => {
  const directory = '/extension/src/providers';
  assert.equal(managedWorkerEntry(directory, (file) => String(file).endsWith('.cjs')), path.join(directory, 'managed-worker.cjs'));
  assert.equal(managedWorkerEntry(directory, (file) => String(file).endsWith('.js')), path.join(directory, 'managed-worker.js'));
  assert.equal(managedWorkerEntry(directory, () => false), '/extension/dist/managed-worker.cjs');
});

test('managed client handles owner notifications and bounded recovery outcomes', { timeout: 8_000 }, async () => {
  const snapshots = [
    { run: { id: 'failed', status: 'failed', updates: [] } },
    { run: { id: 'failed', status: 'failed', updates: [] } },
    { run: { id: 'cancelled', status: 'cancelled', updates: [] } },
    { run: { id: 'cancelled', status: 'cancelled', updates: [] } },
    { run: { id: 'mismatch', status: 'running', updates: [] } },
    { run: { id: 'other', status: 'running', updates: [] } },
  ];
  const interactions: string[] = [];
  const identities: string[] = [];
  const owner = await fakeOwner((request, socket) => {
    if (request.method === 'hello') {
      reply(socket, request.id, { identity });
      socket.write(`${JSON.stringify({ identity })}\n`);
      socket.write(`${JSON.stringify({ interaction: { id: 5, method: 'requestPermission', args: { id: 'permission' } } })}\n`);
      socket.write(`${JSON.stringify({ interaction: { id: 6, method: 'unknownMethod', args: {} } })}\n`);
      socket.write(`${JSON.stringify({ background: { id: 'background', role: 'status', text: 'background update' } })}\n`);
      socket.write(`${JSON.stringify({ id: 999, value: null })}\n`);
      socket.write(`${JSON.stringify({ value: null })}\n`);
      return;
    }
    if (request.method === 'interaction') { interactions.push(String((request.args as { id: number }).id)); reply(socket, request.id, null); return; }
    if (request.method === 'snapshot') { reply(socket, request.id, { identity, ...snapshots.shift() }); return; }
    if (request.method === 'transcript') { reply(socket, request.id, [{ id: 'message', role: 'assistant', text: 'restored' }]); return; }
    if (request.method === 'rateLimits') { reply(socket, request.id, 'none', { sessionClosed: true }); return; }
    reply(socket, request.id, null);
  });
  let session: Awaited<ReturnType<typeof createManagedSession>> | undefined;
  try {
    session = await createManagedSession({ ...owner.options,
      onIdentity: (summary) => identities.push(summary.id),
      interactions: { async requestPermission() { return 'allow-once'; }, async requestPlan() { return 'accepted'; }, async requestAnswers() { return {}; } },
    });
    const transcript: string[] = [];
    await session.loadTranscript?.((message) => transcript.push(message.text));
    assert.deepEqual(transcript, ['restored']);
    assert.equal(session.closed, false);
    await assert.rejects(session.recoverRun?.('failed', new AbortController().signal, () => {}, () => {}) ?? Promise.resolve(), /Managed execution failed/);
    await assert.rejects(session.recoverRun?.('cancelled', new AbortController().signal, () => {}, () => {}) ?? Promise.resolve(), { name: 'AbortError' });
    await assert.rejects(session.recoverRun?.('mismatch', new AbortController().signal, () => {}, () => {}) ?? Promise.resolve(), /does not hold/);
    await session.interruptBackgroundTerminal?.('unknown');
    await session.rateLimits?.();
    assert.equal(session.closed, true);
    assert.ok(identities.includes('fake-thread'));
    assert.deepEqual(interactions, ['5']);
  } finally {
    await session?.detach?.();
    await owner.close();
  }
});

test('managed client rejects malformed replies and marks in-flight work uncertain on disconnect', { timeout: 8_000 }, async () => {
  const owner = await fakeOwner((request, socket) => {
    if (request.method === 'hello') { reply(socket, request.id, { identity }); return; }
    if (request.method === 'rateLimits') { socket.destroy(); }
  });
  try {
    const session = await createManagedSession(owner.options);
    await assert.rejects(session.rateLimits?.() ?? Promise.resolve(), (error: unknown) => {
      assert.equal((error as { executionUncertain?: boolean }).executionUncertain, true);
      return true;
    });
    assert.equal(session.closed, true);
  } finally { await owner.close(); }

  const broken = await fakeOwner((request, socket) => {
    if (request.method === 'hello') socket.write('{invalid json\n');
  });
  try { await assert.rejects(createManagedSession(broken.options), /disconnected/); }
  finally { await broken.close(); }
});

test('managed client cancels recovery when its signal was already aborted', { timeout: 8_000 }, async () => {
  let cancelled = false;
  const owner = await fakeOwner((request, socket) => {
    if (request.method === 'hello') { reply(socket, request.id, { identity }); return; }
    if (request.method === 'snapshot') {
      reply(socket, request.id, { identity, run: { id: 'active', status: cancelled ? 'cancelled' : 'running', updates: [] } });
      return;
    }
    if (request.method === 'cancel') { cancelled = true; reply(socket, request.id, null); socket.write('{"settled":true}\n'); return; }
    reply(socket, request.id, null);
  });
  const session = await createManagedSession(owner.options);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(session.recoverRun?.('active', controller.signal, () => {}, () => {}) ?? Promise.resolve(), { name: 'AbortError' });
    assert.equal(cancelled, true);
  } finally {
    await session.detach?.();
    await owner.close();
  }
});

test('managed client checks cancellation and owner directory permissions before connection', async () => {
  const owner = await fakeOwner((request, socket) => reply(socket, request.id, { identity }));
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(createManagedSession({ ...owner.options, signal: abort.signal }), { name: 'AbortError' });
    await chmod(owner.root, 0o755);
    await assert.rejects(createManagedSession(owner.options), /Unsafe managed directory/);
  } finally {
    await chmod(owner.root, 0o700);
    await owner.close();
  }
});

test('managed client reports a created owner that never opens its socket', async (t) => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-client-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'unavailable-owner', model: 'fixture' };
  const key = createHash('sha256').update(JSON.stringify([cwd, await realpath(cwd), options.ownerKey])).digest('hex').slice(0, 40);
  const root = path.join('/private/tmp', `ai-agents-owner-${process.getuid?.()}-${key}`);
  await mkdir(root, { mode: 0o700 });
  await writeFile(path.join(root, 'token'), 'test-token', { mode: 0o600 });
  let now = 0;
  t.mock.method(Date, 'now', () => { now += 9000; return now; });
  try { await assert.rejects(createManagedSession(options), /Execution owner unavailable/); }
  finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test('managed client surfaces directory creation errors', async (t) => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-client-');
  try {
    t.mock.method(fsPromises, 'mkdir', () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
    await assert.rejects(createManagedSession({ provider: 'codex', backend: 'app-server', cwd,
      storagePath: cwd, ownerKey: 'mkdir-error', model: 'fixture' }), /permission denied/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('managed client reclaims a proven dead owner after its connection deadline', async (t) => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-managed-client-');
  const options: SessionOptions = { provider: 'codex', backend: 'app-server', cwd, storagePath: cwd,
    ownerKey: 'dead-owner', model: 'fixture' };
  const key = createHash('sha256').update(JSON.stringify([cwd, await realpath(cwd), options.ownerKey])).digest('hex').slice(0, 40);
  const root = path.join('/private/tmp', `ai-agents-owner-${process.getuid?.()}-${key}`);
  await mkdir(root, { mode: 0o700 });
  await writeFile(path.join(root, 'token'), 'test-token', { mode: 0o600 });
  await writeFile(path.join(root, 'pid'), '999999999');
  let now = 0;
  t.mock.method(Date, 'now', () => { now += 9000; return now; });
  try {
    await assert.rejects(createManagedSession(options), /Execution owner unavailable/);
    await assert.rejects(realpath(root), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
