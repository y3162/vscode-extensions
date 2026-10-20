import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createManagedSession } from '../../src/providers/managed-session.js';
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
