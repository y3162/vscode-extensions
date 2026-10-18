import '../../support/register-cursor-models-sdk.mjs';

import assert from 'node:assert/strict';

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import childProcess from 'node:child_process';

import { EventEmitter } from 'node:events';

import { PassThrough } from 'node:stream';

import os from 'node:os';

import path from 'node:path';

import { mock, test } from 'node:test';

import { codexModel, cursorModels, listModels } from '../../../src/providers/models.js';

async function withEnv(values: Record<string, string | undefined>, action: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await action(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeCodex(respond: (request: Record<string, unknown>, child: FakeChild) => void): FakeChild {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killCalls: 0, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      this.killCalls += 1;
      if (signal === 'SIGKILL') this.signalCode = 'SIGKILL';
      else this.exitCode = 0;
      emitter.emit('exit', this.exitCode, this.signalCode);
      return true;
    },
  }) as FakeChild;
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) respond(JSON.parse(line) as Record<string, unknown>, child);
    }
  });
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function reply(child: FakeChild, message: unknown): void {
  queueMicrotask(() => child.stdout.write(`${JSON.stringify(message)}\n`));
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killCalls: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

test('Codex model conversion rejects malformed or hidden entries and omits unusable effort controls', () => {
  assert.equal(codexModel({}), undefined);
  assert.equal(codexModel({ model: '', hidden: false }), undefined);
  assert.equal(codexModel({ model: 'hidden-model', hidden: true }), undefined);

  const model = codexModel({
    model: 'basic-model', isDefault: false, supportedReasoningEfforts: [
      null, {}, { reasoningEffort: 1 }, { reasoningEffort: 'low' },
    ],
  });
  assert.deepEqual(model, { id: 'basic-model', label: 'basic-model', description: undefined, isDefault: false });

  const described = codexModel({
    model: 'effort-model', description: 'A model', defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'high', description: 'More reasoning' },
    ],
  });
  assert.equal(described?.description, 'A model');
  assert.equal(described?.parameters?.[0]?.defaultValue, 'high');
  assert.equal(described?.parameters?.[0]?.values[0]?.description, undefined);
});

test('bundled Codex discovery launches the public CLI with key configuration and deduplicates pages', async (t) => {
  const child = fakeCodex((request, worker) => {
    if (request.method === 'initialize') reply(worker, { id: request.id, result: {} });
    if (request.method === 'model/list') {
      const page = request.params as { cursor?: string };
      reply(worker, { id: request.id, result: page.cursor ? { data: [
        { model: 'model-b' }, { model: 'model-a', displayName: 'Duplicate A' }, null, {},
      ] } : { data: [{ model: 'model-a', displayName: 'Model A' }], nextCursor: 'page-2' } });
    }
  });
  const launches: { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    launches.push({ command, args: [...args], options: options as { cwd?: string; env?: NodeJS.ProcessEnv } });
    return child as never;
  });

  await withEnv({ CODEX_API_KEY: undefined, OPENAI_API_KEY: 'openai-key' }, async () => {
    const models = await listModels({ provider: 'codex', cwd: '/workspace' });
    assert.deepEqual(models.map((model) => [model.id, model.label]), [['model-a', 'Model A'], ['model-b', 'model-b']]);
  });

  const launch = launches[0]!;
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0] ?? '', /@openai[\/]codex[\/]bin[\/]codex\.js$/);
  assert.deepEqual(launch.args.slice(1), ['app-server', '--listen', 'stdio://', '-c', 'model_providers.openai.env_key="CODEX_API_KEY"']);
  assert.equal(launch.options.cwd, '/workspace');
  assert.equal(launch.options.env?.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launch.options.env?.CODEX_API_KEY, 'openai-key');
});

test('Codex listing rejects missing arrays and repeated page cursors, then cleans up the child', async (t) => {
  for (const mode of ['missing-data', 'repeat-cursor'] as const) {
    const child = fakeCodex((request, worker) => {
      if (request.method === 'initialize') reply(worker, { id: request.id, result: {} });
      if (request.method === 'model/list') reply(worker, { id: request.id, result: mode === 'missing-data'
        ? { data: null }
        : { data: [], nextCursor: 'same' } });
    });
    const spawn = t.mock.method(childProcess, 'spawn', () => child as never);
    try {
      await assert.rejects(listModels({ provider: 'codex', codexPath: '/fixture/codex' }), mode === 'missing-data' ? /一覧が不正/ : /循環しています/);
      assert.equal(child.exitCode, 0);
    } finally { spawn.mock.restore(); }
  }
});

test('aborting a Codex catalog request after spawn rejects the pending RPC and stops its child', async (t) => {
  const requestStarted = deferred<void>();
  const child = fakeCodex((request, worker) => {
    if (request.method === 'initialize') reply(worker, { id: request.id, result: {} });
    if (request.method === 'model/list') requestStarted.resolve();
  });
  t.mock.method(childProcess, 'spawn', () => child as never);
  const controller = new AbortController();
  const pending = listModels({ provider: 'codex', codexPath: '/fixture/codex', signal: controller.signal });
  await requestStarted.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(child.exitCode, 0, 'abort terminates the synthetic child');
  assert.equal(child.killCalls, 1, 'final cleanup does not kill a child that the abort listener already stopped');
});

test('Codex spawn errors and API-key precedence are surfaced and forwarded', async (t) => {
  await assert.rejects(listModels({ provider: 'codex', codexPath: '/path/that/does/not/exist' }), /ENOENT/);

  const child = fakeCodex((request, worker) => {
    if (request.method === 'initialize') reply(worker, { id: request.id, result: {} });
    if (request.method === 'model/list') reply(worker, { id: request.id, result: { data: [] } });
  });
  const launches: { command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }[] = [];
  t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    launches.push({ command, args: [...args], options: options as { env?: NodeJS.ProcessEnv } });
    return child as never;
  });
  await withEnv({ CODEX_API_KEY: 'codex-env-key', OPENAI_API_KEY: 'openai-env-key' }, async () => {
    await listModels({ provider: 'codex', codexPath: '/fixture/codex', apiKey: 'explicit-key' });
  });
  assert.equal(launches[0]?.command, '/fixture/codex');
  assert.deepEqual(launches[0]?.args, ['app-server', '--listen', 'stdio://', '-c', 'model_providers.openai.env_key="CODEX_API_KEY"']);
  assert.equal(launches[0]?.options.env?.CODEX_API_KEY, 'explicit-key');
});

test('Codex catalog startup keeps a meaningful process error when stdin EPIPE races with exit', async (t) => {
  for (const order of ['exit-first', 'pipe-first'] as const) {
    const child = fakeCodex((request, worker) => {
      if (request.method !== 'initialize') return;
      const emitExit = () => {
        worker.exitCode = 7;
        worker.emit('exit', 7, null);
      };
      const emitPipeError = () => {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        worker.stdin.emit('error', error);
      };
      if (order === 'exit-first') { emitExit(); emitPipeError(); }
      else { emitPipeError(); emitExit(); }
    });
    const spawn = t.mock.method(childProcess, 'spawn', () => child as never);
    try {
      await assert.rejects(listModels({ provider: 'codex', codexPath: '/fixture/codex' }), (error: unknown) => {
        const message = String(error);
        assert.match(message, /Codex/);
        assert.match(message, /終了|通信/);
        assert.doesNotMatch(message, /write EPIPE/);
        return true;
      });
    } finally { spawn.mock.restore(); }
  }
});

test('Codex catalog handles a real child stdin pipe closing after initialize', {
  skip: process.platform === 'win32', timeout: 8_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-agents-catalog-epipe-'));
  const command = path.join(directory, 'codex-helper');
  const requests = path.join(directory, 'requests.log');
  const helper = `#!/bin/bash
requests=${JSON.stringify(requests)}
log() { printf '%s\\n' "$1" >> "$requests"; }
timer=
trap 'kill "$timer" 2>/dev/null || true; log SIGTERM; exit 0' TERM
IFS= read -r request || exit 2
log initialize
exec 0<&-
printf '%s\\n' '{"id":1,"result":{}}'
sleep 3 &
timer=$!
wait "$timer"
log TIMEOUT
`;
  await writeFile(command, helper, { mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      listModels({ provider: 'codex', codexPath: command }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Codex.*通信が切断/);
        assert.doesNotMatch(error.message, /EPIPE|write|broken pipe/i);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_500, 'the catalog call should fail promptly when the peer closes stdin');
    const cleanupDeadline = Date.now() + 1_000;
    let log = '';
    do {
      log = await readFile(requests, 'utf8');
      if (log.includes('SIGTERM')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < cleanupDeadline);
    assert.match(log, /initialize/);
    assert.doesNotMatch(log, /model\/list|initialized/);
    assert.match(log, /SIGTERM/, 'the failed child must be stopped during cleanup');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
