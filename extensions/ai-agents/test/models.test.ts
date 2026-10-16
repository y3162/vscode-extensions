import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexModel, cursorModels, listModels } from '../src/providers/models.js';

async function fixture(t: TestContext, mode = '') {
  const cwd = await mkdtemp(join(tmpdir(), 'ai-agents-models-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const codexPath = join(cwd, 'codex.cjs');
  await cp(join(__dirname, 'fixtures', 'mock-codex.cjs'), codexPath);
  await chmod(codexPath, 0o755);
  await writeFile(join(cwd, 'model-mode.txt'), mode);
  return { provider: 'codex' as const, cwd, codexPath };
}

test('Codex discovery initializes the protocol, collects all pages, hides hidden models, and uses wire model IDs', async (t) => {
  const models = await listModels(await fixture(t));
  assert.deepEqual(models.map((model) => model.id), ['fixture-model', 'fixture-second']);
  assert.equal(models[0]?.label, 'Fixture Model');
});

test('Codex model-list errors and unexpected exits are surfaced', async (t) => {
  await assert.rejects(listModels(await fixture(t, 'error')), /fixture model catalog unavailable/);
  await assert.rejects(listModels(await fixture(t, 'exit')), /終了しました \(7\)/);
  await assert.rejects(listModels(await fixture(t, 'malformed')), /応答が不正/);
});

test('closing a waiting model picker aborts discovery instead of leaving a subprocess running', async (t) => {
  const options = await fixture(t, 'wait');
  await assert.rejects(listModels({ ...options, signal: AbortSignal.timeout(150) }), { name: 'TimeoutError' });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(listModels({ ...options, signal: abort.signal }), { name: 'AbortError' });
});

test('Cursor effort, context, and speed combinations produce one base-model row', () => {
  const models = cursorModels([{
    id: 'fixture-model', displayName: 'Fixture Model',
    parameters: [
      { id: 'effort', displayName: 'Effort', values: [{ value: 'low' }, { value: 'high' }] },
      { id: 'context', displayName: 'Context size', values: [{ value: '200k' }, { value: '1m' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
    ],
    variants: [
      { displayName: 'Fixture Model Low 200K', params: [{ id: 'effort', value: 'low' }, { id: 'context', value: '200k' }] },
      { displayName: 'Fixture Model High 1M', isDefault: true, params: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }] },
    ],
  }]);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.label, 'Fixture Model');
  assert.deepEqual(models[0]?.defaultParams, [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }, { id: 'fast', value: 'false' }]);
  assert.deepEqual(models[0]?.parameters?.[1], {
    id: 'context', label: 'Context size', role: 'context', presentation: 'menu', defaultValue: '1m', values: [
      { value: '200k', label: '200K' }, { value: '1m', label: '1M' },
    ],
  });
  assert.equal(models[0]?.parameters?.[2]?.presentation, 'toggle');
  assert.equal(models[0]?.parameters?.[0]?.role, 'effort');
  assert.equal(models[0]?.presets?.length, 2);
});

test('different model versions remain separate even when the SDK shares aliases', () => {
  const models = cursorModels([
    { id: 'fixture-v1', displayName: 'Fixture 1', aliases: ['fixture', 'fixture-one'] },
    { id: 'fixture-v2', displayName: 'Fixture 2', aliases: ['fixture', 'fixture-two'] },
    { id: 'fixture-v2', displayName: 'Fixture 2', aliases: ['fixture', 'fixture-two'] },
  ]);
  assert.deepEqual(models.map((model) => model.id), ['fixture-v1', 'fixture-v2']);
  assert.deepEqual(models[0]?.aliases, ['fixture-one']);
  assert.deepEqual(models[1]?.aliases, ['fixture-two']);
});

test('Codex keeps effort capabilities on one model entry for a separate detail control', () => {
  const model = codexModel({ model: 'fixture-codex', displayName: 'Fixture Codex',
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low effort' },
      { reasoningEffort: 'medium', description: 'Medium effort' },
    ],
  });
  assert.equal(model?.label, 'Fixture Codex');
  assert.equal(model?.parameters?.[0]?.defaultValue, 'medium');
  assert.equal(model?.parameters?.[0]?.values[0]?.label, 'Low');
  assert.deepEqual(model?.parameters?.map((parameter) => parameter.role), ['effort']);
  assert.deepEqual(model?.parameters?.[0]?.values.map((value) => value.value), ['low', 'medium']);
  assert.equal(model?.defaultParams, undefined);
});
