import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import childProcess from 'node:child_process';

import { mock, test, type TestContext } from 'node:test';

import { createSession, cursorNodeVersionSupported, interruptCursorBackgroundShell, listCursorSdkSessions, loadCodexSdk, loadCursorSdkForSession, writeBaselineFile } from '../../../src/providers/index.js';

import { createCursorSdkLoader, cursorSdkRuntimeEntry, loadCursorSdk, loadCursorSdkEntry, loadPublishedCursorSdk } from '../../../src/providers/cursor-sdk.js';

import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function loader(overrides: Partial<Loaders> = {}): Loaders {
  return {
    codex: async () => { throw new Error('Unexpected Codex SDK load'); },
    cursor: async () => { throw new Error('Unexpected Cursor SDK load'); },
    ...overrides,
  };
}

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

test('Cursor Node support is a pure check across supported and unsupported boundaries', () => {
  assert.equal(cursorNodeVersionSupported('21.99.0'), false);
  assert.equal(cursorNodeVersionSupported('22.12.99'), false);
  assert.equal(cursorNodeVersionSupported('22.13.0'), true);
  assert.equal(cursorNodeVersionSupported('22.20.1'), true);
  assert.equal(cursorNodeVersionSupported('23.0.0'), true);
  assert.equal(cursorNodeVersionSupported('bad'), false);
});

test('Cursor native terminal interrupt matches both shell id and PID and fails closed without a runtime', (t) => {
  const runtime = new CursorBackgroundRuntime();
  t.after(() => runtime.dispose());
  const shells = new Map([[7, { pid: 501 }]]);
  const aborted: number[] = [];
  runtime.release({
    getManager: () => ({ runningShells: shells, abort: (id) => { aborted.push(id); return true; } }),
    dispose() {},
  });

  assert.equal(interruptCursorBackgroundShell(7, 502, runtime), false, 'a different PID is never interrupted');
  assert.equal(interruptCursorBackgroundShell(8, 501, runtime), false, 'a different shell is never interrupted');
  assert.equal(interruptCursorBackgroundShell(7, 501, runtime), true);
  assert.deepEqual(aborted, [7]);
  assert.equal(interruptCursorBackgroundShell(7, 501, null), false, 'absence of the worker runtime keeps the normal signal fallback available');
});

test('Cursor loader enforces the Node floor before loading and published SDK resolution is local', async (t) => {
  const cwd = await directory(t);
  let loads = 0;
  await assert.rejects(createSession(
    { provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'too-old'), apiKey: 'key' },
    loader({ cursor: async () => { loads += 1; throw new Error('SDK must not load'); } }),
    true,
    { nodeVersion: '22.12.99' },
  ), /22\.13/);
  assert.equal(loads, 0);
  const published = loadPublishedCursorSdk();
  const loaded = await loadCursorSdk();
  assert.equal(typeof published.Agent.create, 'function');
  assert.equal(typeof published.Cursor.auth.status, 'function');
  assert.equal(loaded.Agent, published.Agent);
});

test('default SDK loaders resolve local modules without constructing clients or starting agents', async () => {
  const codex = await loadCodexSdk();
  const cursor = await loadCursorSdkForSession();
  assert.equal(typeof codex.Codex, 'function');
  assert.equal(typeof cursor.Agent.create, 'function');
});

test('Cursor worker SDK entry selection uses packaged code or the dist fallback without probing outside the worker', () => {
  const directory = '/synthetic/extension/src/providers';
  let probes = 0;
  assert.equal(cursorSdkRuntimeEntry(false, directory, () => { probes += 1; return true; }), undefined);
  assert.equal(probes, 0, 'catalog callers do not probe the worker bundle');

  const packaged = path.join(directory, 'cursor-sdk', 'index.js');
  assert.equal(cursorSdkRuntimeEntry(true, directory, (candidate) => { probes += 1; return candidate === packaged; }), packaged);
  assert.equal(cursorSdkRuntimeEntry(true, directory, () => { probes += 1; return false; }), path.resolve(directory, '../../dist/cursor-sdk/index.js'));
  assert.equal(cursorSdkRuntimeEntry(true, directory), path.resolve(directory, '../../dist/cursor-sdk/index.js'));
  assert.equal(probes, 2);
});

test('the worker runtime loader requires its selected entry without loading the real SDK', async (t) => {
  const cwd = await directory(t);
  const entry = path.join(cwd, 'synthetic-sdk.cjs');
  await writeFile(entry, "module.exports = { marker: 'synthetic SDK entry' };\n");
  const loaded = loadCursorSdkEntry(entry) as unknown as { marker: string };
  assert.deepEqual(loaded, { marker: 'synthetic SDK entry' });
});

test('Cursor SDK loader routes published callers and worker callers through injectable loaders', async () => {
  const directory = '/synthetic/extension/src/providers';
  const sdk = {} as typeof import('@cursor/sdk');
  let publishedCalls = 0;
  let routedEntry: string | undefined;
  const publishedRoute = createCursorSdkLoader({
    runtimeAvailable: () => false,
    directory,
    fileExists: () => { throw new Error('published route must not probe worker files'); },
    loadPublished: () => { publishedCalls += 1; return sdk; },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await publishedRoute(), sdk);
  assert.equal(publishedCalls, 1);
  assert.equal(routedEntry, undefined);

  const packaged = path.join(directory, 'cursor-sdk', 'index.js');
  const workerRoute = createCursorSdkLoader({
    runtimeAvailable: () => true,
    directory,
    fileExists: (entry) => entry === packaged,
    loadPublished: () => { throw new Error('worker route must not use the published SDK'); },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await workerRoute(), sdk);
  assert.equal(routedEntry, packaged);

  routedEntry = undefined;
  const fallbackRoute = createCursorSdkLoader({
    runtimeAvailable: () => true,
    directory,
    fileExists: () => false,
    loadPublished: () => { throw new Error('worker fallback must stay bundled'); },
    loadEntry: (entry) => { routedEntry = entry; return sdk; },
  });
  assert.equal(await fallbackRoute(), sdk);
  assert.equal(routedEntry, path.resolve(directory, '../../dist/cursor-sdk/index.js'));
});

test('createSession selects App Server and ACP transports before SDK loaders', async (t) => {
  const cwd = await directory(t);
  const unavailable = loader({
    codex: async () => { throw new Error('Codex SDK route must not run'); },
    cursor: async () => { throw new Error('Cursor SDK route must not run'); },
  });
  await assert.rejects(createSession({
    provider: 'codex', backend: 'app-server', cwd, model: '', storagePath: cwd,
    codexPath: path.join(cwd, 'missing-codex'), sandbox: 'workspace-write', approval: 'never',
  }, unavailable), /ENOENT|spawn/);
  await assert.rejects(createSession({
    provider: 'cursor', backend: 'acp', cwd, model: '', storagePath: cwd,
    agentPath: path.join(cwd, 'missing-agent'), sandbox: 'enabled',
  }, unavailable), /ENOENT|spawn/);
});

test('the default Cursor SDK route starts the isolated worker instead of loading the SDK in-process', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: { resume() {} }, stderr: { resume() {} },
    send(message: { id: number; method: string }, callback: (error?: Error | null) => void) {
      callback();
      if (message.method !== 'initialize') queueMicrotask(() => child.emit('message', { id: message.id }));
      else queueMicrotask(() => child.emit('message', { id: message.id, value: { ready: true } }));
    },
    kill() { return true; },
  });
  const fork = mock.method(childProcess, 'fork', () => child);
  try {
    const session = await createSession({ provider: 'cursor', cwd: '/synthetic', model: 'auto', storagePath: '/synthetic' });
    assert.equal(typeof session.setModel, 'function');
    assert.equal(fork.mock.calls.length, 1);
    assert.equal(fork.mock.calls[0]?.arguments[2]?.execArgv?.length, 0);
    await session.dispose();
  } finally { fork.mock.restore(); }
});
