import '../../support/register-cursor-models-sdk.mjs';

import assert from 'node:assert/strict';

import { mock, test } from 'node:test';

import { codexModel, cursorModels, listModels } from '../../../src/providers/models.js';

import { Cursor, cursorModelsStub } from '../../support/cursor-models-sdk-stub.js';

function resetCursorStub(): void {
  cursorModelsStub.statusCalls = 0;
  cursorModelsStub.listCalls.length = 0;
  cursorModelsStub.statusImpl = async () => ({ status: 'logged-in' });
  cursorModelsStub.listImpl = async () => [{ id: 'cursor-fixture', displayName: 'Cursor Fixture' }];
}

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

test('Cursor discovery authenticates only when needed and maps the SDK model list', async () => {
  resetCursorStub();
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    const models = await listModels({ provider: 'cursor', apiKey: 'explicit-key' });
    assert.equal(cursorModelsStub.statusCalls, 0);
    assert.deepEqual(cursorModelsStub.listCalls, [{ apiKey: 'explicit-key' }]);
    assert.deepEqual(models.map(({ id, label }) => ({ id, label })), [{ id: 'cursor-fixture', label: 'Cursor Fixture' }]);

    resetCursorStub();
    await listModels({ provider: 'cursor' });
    assert.equal(cursorModelsStub.statusCalls, 1);
    assert.deepEqual(cursorModelsStub.listCalls, [{ apiKey: undefined }]);
  });
});

test('Cursor discovery honors environment authentication and propagates auth/catalog failures', async () => {
  resetCursorStub();
  await withEnv({ CURSOR_API_KEY: 'environment-key' }, async () => {
    await listModels({ provider: 'cursor' });
    assert.equal(cursorModelsStub.statusCalls, 0);
    assert.deepEqual(cursorModelsStub.listCalls, [{ apiKey: undefined }]);
  });

  resetCursorStub();
  cursorModelsStub.statusImpl = async () => ({ status: 'logged-out' });
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    await assert.rejects(listModels({ provider: 'cursor' }), /未ログイン/);
  });
  assert.deepEqual(cursorModelsStub.listCalls, []);

  resetCursorStub();
  cursorModelsStub.statusImpl = async () => { throw new Error('auth status unavailable'); };
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    await assert.rejects(listModels({ provider: 'cursor' }), /auth status unavailable/);
  });
  assert.deepEqual(cursorModelsStub.listCalls, []);

  resetCursorStub();
  cursorModelsStub.listImpl = async () => { throw new Error('model catalog unavailable'); };
  await assert.rejects(listModels({ provider: 'cursor', apiKey: 'explicit-key' }), /model catalog unavailable/);
});

test('Cursor discovery aborts before work and while auth or catalog calls are pending', async () => {
  resetCursorStub();
  const before = new AbortController();
  before.abort();
  await assert.rejects(listModels({ provider: 'cursor', signal: before.signal }), { name: 'AbortError' });
  assert.equal(cursorModelsStub.statusCalls, 0);
  assert.deepEqual(cursorModelsStub.listCalls, []);

  resetCursorStub();
  const duringImport = new AbortController();
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    const pending = listModels({ provider: 'cursor', signal: duringImport.signal });
    duringImport.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
  assert.equal(cursorModelsStub.statusCalls, 0, 'an abort during SDK module loading does not start auth');

  resetCursorStub();
  const duringAuth = new AbortController();
  const canceledAuth = deferred<{ status: string }>();
  cursorModelsStub.statusImpl = () => { duringAuth.abort(); return canceledAuth.promise; };
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    await assert.rejects(listModels({ provider: 'cursor', signal: duringAuth.signal }), { name: 'AbortError' });
  });
  canceledAuth.resolve({ status: 'logged-in' });

  resetCursorStub();
  const auth = deferred<{ status: string }>();
  const authStarted = deferred<void>();
  cursorModelsStub.statusImpl = () => { authStarted.resolve(); return auth.promise; };
  const authAbort = new AbortController();
  await withEnv({ CURSOR_API_KEY: undefined }, async () => {
    const pending = listModels({ provider: 'cursor', signal: authAbort.signal });
    await authStarted.promise;
    authAbort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
  auth.resolve({ status: 'logged-in' });

  resetCursorStub();
  const catalog = deferred<unknown[]>();
  const catalogStarted = deferred<void>();
  cursorModelsStub.listImpl = () => { catalogStarted.resolve(); return catalog.promise; };
  const catalogAbort = new AbortController();
  const pendingCatalog = listModels({ provider: 'cursor', apiKey: 'explicit-key', signal: catalogAbort.signal });
  await catalogStarted.promise;
  catalogAbort.abort();
  await assert.rejects(pendingCatalog, { name: 'AbortError' });
  catalog.resolve([{ id: 'late' }]);
  assert.equal(Cursor.models !== undefined, true);
});

test('Cursor catalog conversion handles empty catalogs and incomplete model metadata', () => {
  assert.deepEqual(cursorModels([]), []);
  const models = cursorModels([{
    id: 'fallback-name', displayName: '', aliases: ['shared', 'only-here'],
    parameters: [
      { id: 'single', values: [{ value: 'one' }] },
      { id: 'empty', values: [] },
    ],
    variants: [{ displayName: 'Preset without parameters', params: [] }],
  }, {
    id: 'other-model', displayName: 'Other Model', aliases: ['shared'],
  }]);
  assert.equal(models[0]?.label, 'fallback-name');
  assert.deepEqual(models[0]?.aliases, ['only-here']);
  assert.deepEqual(models[0]?.defaultParams, [{ id: 'single', value: 'one' }]);
  assert.deepEqual(models[0]?.parameters, []);
  assert.deepEqual(models[0]?.presets, [{ label: 'Preset without parameters', description: undefined, isDefault: undefined, params: [] }]);
  assert.deepEqual(models[1]?.aliases, []);
});
