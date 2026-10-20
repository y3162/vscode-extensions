import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

const fixture = path.resolve('test/fixtures/mock-app-server.cjs');
const compiledWorker = path.resolve('src/providers/managed-worker.js');
const workerEntry = existsSync(compiledWorker) ? compiledWorker : path.resolve('src/providers/managed-worker.ts');

async function startWorker(unsafe = false, jumpClock = false) {
  const cwd = await mkdtemp('/private/tmp/ai-agents-worker-protocol-');
  const root = path.join(cwd, 'owner');
  await mkdir(root, { mode: unsafe ? 0o755 : 0o700 });
  await chmod(root, unsafe ? 0o755 : 0o700);
  await writeFile(path.join(root, 'token'), 'protocol-token', { mode: 0o600 });
  const clockPath = path.join(cwd, 'jump-clock.cjs');
  if (jumpClock) await writeFile(clockPath, `const actual = Date.now; let offset = 0;
setTimeout(() => { offset = 11 * 60_000; }, 250);
Date.now = () => actual() + offset;`);
  const worker = spawn(process.execPath, [...(workerEntry.endsWith('.ts') ? ['--import', 'tsx'] : []), workerEntry, root],
    { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
      ...(jumpClock ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${clockPath}`].filter(Boolean).join(' ') } : {}) } });
  async function waitForSocket() {
    const deadline = Date.now() + 4000;
    while (!existsSync(path.join(root, 'control.sock')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(path.join(root, 'control.sock')), 'worker must open its owner socket');
  }
  async function open(): Promise<Socket> {
    const socket = connect(path.join(root, 'control.sock'));
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return socket;
  }
  return { cwd, root, worker, waitForSocket, open, async cleanup() {
    worker.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null || worker.signalCode !== null) resolve();
      else worker.once('exit', () => resolve());
    });
    await rm(cwd, { recursive: true, force: true });
  } };
}

function messages(socket: Socket) {
  let buffer = '';
  const queue: unknown[] = [];
  const events: unknown[] = [];
  const waiting: Array<(message: unknown) => void> = [];
  socket.on('data', (chunk) => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as unknown;
      buffer = buffer.slice(newline + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(message);
      else queue.push(message);
    }
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<unknown>((resolve) => waiting.push(resolve));
  let id = 0;
  return { async notification(predicate: (value: { interaction?: unknown }) => boolean) {
    while (true) {
      const index = events.findIndex((event) => predicate(event as { interaction?: unknown }));
      if (index >= 0) return events.splice(index, 1)[0];
      const message = await next();
      if (predicate(message as { interaction?: unknown })) return message;
      events.push(message);
    }
  }, async request(method?: string, args?: unknown, token?: string) {
    const requestId = ++id;
    socket.write(`${JSON.stringify({ id: requestId, method, args, token })}\n`);
    while (true) {
      const message = await next() as { id?: number; error?: string; value?: unknown };
      if (message.id === requestId) return message;
      events.push(message);
    }
  } };
}

test('managed worker rejects operations before initialization and accepts its supported controls', { timeout: 8_000 }, async () => {
  const owner = await startWorker();
  let socket: Socket | undefined;
  try {
    await owner.waitForSocket();
    const anonymous = await owner.open();
    const rejected = once(anonymous, 'close');
    anonymous.write('{"id":1}\n');
    await rejected;
    socket = await owner.open();
    const protocol = messages(socket);
    assert.equal((await protocol.request('hello', undefined, 'protocol-token')).error, undefined);
    assert.match((await protocol.request('run', { prompt: 'hello' })).error ?? '', /not initialized/);
    assert.match((await protocol.request()).error ?? '', /not initialized/);
    assert.match((await protocol.request('initialize', { provider: 'cursor', backend: 'app-server' })).error ?? '', /Unsupported managed backend/);
    const options = { provider: 'codex', backend: 'app-server', cwd: owner.cwd, storagePath: owner.cwd,
      model: 'fixture', codexPath: fixture };
    const initialized = await protocol.request('initialize', options);
    assert.equal((initialized.value as { identity?: { id?: string } }).identity?.id, 'thread-1');
    assert.equal((await protocol.request('snapshot')).error, undefined);
    assert.equal((await protocol.request('interaction', { id: 999, value: 'unused' })).error, undefined);
    assert.match((await protocol.request('run', { prompt: 'hello', turn: {} })).error ?? '', /stable execution id/);
    assert.match((await protocol.request('setModel', { provider: 'codex', cwd: owner.cwd, model: 'fixture' })).error ?? '', /Unsupported managed operation/);
    assert.equal((await protocol.request('terminals')).error, undefined);
    assert.equal((await protocol.request('run', { prompt: 'MANAGED_RELOAD_GATE', turn: {
      executionId: 'cancelled-run', intent: 'chat', mode: 'agent',
      selection: { provider: 'codex', cwd: owner.cwd, model: 'fixture' },
    } })).error, undefined);
    await protocol.request('cancel');
    let status = 'running';
    for (let attempt = 0; attempt < 20 && status === 'running'; attempt++) {
      const snapshot = (await protocol.request('snapshot')).value as { run?: { status?: string } };
      status = snapshot.run?.status ?? '';
      if (status === 'running') await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, 'cancelled');
    assert.equal((await protocol.request('dispose')).error, undefined);
  } finally {
    socket?.destroy();
    await owner.cleanup();
  }
});

test('managed worker resolves pending approval and question requests during shutdown', { timeout: 8_000 }, async () => {
  for (const prompt of ['NEED_APPROVAL', 'NEED_ANSWERS']) {
    const owner = await startWorker();
    let socket: Socket | undefined;
    try {
      await owner.waitForSocket();
      socket = await owner.open();
      const protocol = messages(socket);
      await protocol.request('hello', undefined, 'protocol-token');
      await protocol.request('initialize', { provider: 'codex', backend: 'app-server', cwd: owner.cwd,
        storagePath: owner.cwd, model: 'fixture', codexPath: fixture });
      await protocol.request('run', { prompt, turn: { executionId: prompt, intent: 'chat', mode: 'agent',
        selection: { provider: 'codex', cwd: owner.cwd, model: 'fixture' } } });
      let timer: ReturnType<typeof setTimeout>;
      const event = await Promise.race([
        protocol.notification((value) => Boolean(value.interaction)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('interaction was not forwarded')), 2000); }),
      ]).finally(() => clearTimeout(timer)) as { interaction: { method: string } };
      assert.equal(event.interaction.method, prompt === 'NEED_APPROVAL' ? 'requestPermission' : 'requestAnswers');
      owner.worker.kill('SIGTERM');
      owner.worker.kill('SIGTERM');
      const exitCode = await new Promise<number | null>((resolve) => owner.worker.once('exit', resolve));
      assert.equal(exitCode, 0);
    } finally {
      socket?.destroy();
      await owner.cleanup();
    }
  }
});

test('managed worker rejects an unsafe owner directory before opening the socket', { timeout: 8_000 }, async () => {
  const owner = await startWorker(true);
  try {
    const code = await new Promise<number | null>((resolve) => owner.worker.once('exit', resolve));
    assert.equal(code, 1);
    assert.equal(existsSync(path.join(owner.root, 'control.sock')), false);
  } finally { await owner.cleanup(); }
});

test('managed worker shuts down after the disconnected owner grace period', { timeout: 5_000 }, async () => {
  const owner = await startWorker(false, true);
  try {
    await owner.waitForSocket();
    const code = await new Promise<number | null>((resolve) => owner.worker.once('exit', resolve));
    assert.equal(code, 0);
    assert.equal(existsSync(owner.root), false);
  } finally { await owner.cleanup(); }
});
