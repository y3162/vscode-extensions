import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexModel, listModels } from '../../../src/providers/models.js';

async function fixture(t: TestContext, mode = '') {
  const cwd = await mkdtemp(join(tmpdir(), 'ai-agents-models-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const codexPath = join(cwd, 'codex.cjs');
  await cp(join(__dirname, '../../fixtures', 'mock-codex.cjs'), codexPath);
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
