import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test, type TestContext } from 'node:test';

import type { createSession } from '../../../src/providers/index.js';

import type { AgentUpdate, SessionSummary, TurnOptions } from '../../../src/types.js';

type Loaders = NonNullable<Parameters<typeof createSession>[1]>;

type CodexSdk = Awaited<ReturnType<Loaders['codex']>>;

async function directory(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-round5-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('Codex retargeting to an empty model and empty prompt keeps SDK defaults and a stable identity', async (t) => {
  const cwd = await directory(t);
  const resumed: Array<{ id: string; options: Record<string, unknown> }> = [];
  const identities: SessionSummary[] = [];
  const thread = {
    id: 'saved-thread',
    async runStreamed() {
      return { events: (async function* () { yield { type: 'thread.started', thread_id: 'saved-thread' }; })() };
    },
  };
  class Codex {
    constructor(_options: unknown) {}
    startThread(_options: unknown) { throw new Error('resume path must not start'); }
    resumeThread(id: string, options: Record<string, unknown>) { resumed.push({ id, options }); return thread; }
  }
  const sdk = { Codex } as unknown as CodexSdk;
  const loaders: Loaders = { codex: async () => sdk, cursor: async () => { throw new Error('Cursor not selected'); } };
  const { createSession } = await import('../../../src/providers/index.js');
  const session = await createSession({
    provider: 'codex', cwd, model: 'gpt-test', storagePath: cwd, resumeId: 'saved-thread',
    onIdentity: (identity) => identities.push(identity),
  }, loaders, true);
  try {
    session.setModel!({ provider: 'codex', cwd, model: '' });
    assert.equal(resumed.length, 2, 'the initial thread is resumed once, then retargeted');
    assert.equal(resumed.at(-1)?.id, 'saved-thread');
    assert.equal(resumed.at(-1)?.options.model, undefined, 'an empty selection restores the SDK default model');
    await session.run('', new AbortController().signal, () => {});
    assert.equal(identities[0]?.title, 'Codex', 'an empty prompt still gives the restored thread a useful identity');
  } finally {
    await session.dispose();
  }
});

test('Codex SDK enriches rename and update metadata from tracked baselines and preserves supplied fallback text', async (t) => {
  const cwd = await directory(t);
  await writeFile(path.join(cwd, 'old.txt'), 'old source\n');
  await writeFile(path.join(cwd, 'ordinary.txt'), 'ordinary before\n');
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd });
  execFileSync('git', ['add', 'old.txt', 'ordinary.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'synthetic codex baseline', '--quiet'], { cwd });

  const thread = {
    id: 'codex-file-thread',
    async runStreamed() {
      writeFileSync(path.join(cwd, 'new.txt'), 'new target\n');
      writeFileSync(path.join(cwd, 'ordinary.txt'), 'ordinary after\n');
      writeFileSync(path.join(cwd, 'fallback.txt'), 'fallback after\n');
      const events = (async function* () {
        yield { type: 'thread.started', thread_id: 'codex-file-thread' };
        yield { type: 'item.completed', item: { id: 'rename', type: 'file_change', status: 'completed', changes: [
          { path: 'old.txt', kind: { type: 'update', movePath: 'new.txt' }, diff: '-old source\n+new target\n' },
          { path: 'ordinary.txt', kind: 'update', diff: '-ordinary before\n+ordinary after\n' },
          { path: 'fallback.txt', kind: { type: 'rename', movePath: 'missing-source.txt' }, previousText: 'fallback before\n', diff: '-fallback before\n+fallback after\n' },
        ] } };
      })();
      return { events };
    },
  };
  class Codex {
    constructor(_options: unknown) {}
    startThread(_options: unknown) { return thread; }
    resumeThread(_id: string, _options: unknown) { return thread; }
  }
  const sdk = { Codex } as unknown as CodexSdk;
  const loaders: Loaders = { codex: async () => sdk, cursor: async () => { throw new Error('Cursor not selected'); } };
  const { createSession } = await import('../../../src/providers/index.js');
  const session = await createSession({ provider: 'codex', cwd, model: '', storagePath: path.join(cwd, 'store') }, loaders, true);
  try {
    const updates: AgentUpdate[] = [];
    await session.run('inspect synthetic changes', new AbortController().signal, (update) => updates.push(update));
    const files = updates.find((update) => update.id === 'rename')?.meta?.files ?? [];
    const renamed = files.find((file) => file.path === 'new.txt');
    assert.equal(renamed?.kind, 'rename');
    assert.equal(renamed?.oldPath, 'old.txt');
    assert.equal(renamed?.previousText, 'old source\n');
    assert.equal(renamed?.previousMode, 0o644);
    assert.equal(renamed?.additions, 1);
    assert.equal(renamed?.deletions, 1);

    const ordinary = files.find((file) => file.path === 'ordinary.txt');
    assert.equal(ordinary?.previousText, 'ordinary before\n', 'updates without oldPath look up their own tracked path');
    assert.equal(ordinary?.previousMode, 0o644);
    const fallback = files.find((file) => file.path === 'fallback.txt');
    assert.equal(fallback?.oldPath, 'missing-source.txt');
    assert.equal(fallback?.previousText, 'fallback before\n', 'server-supplied old text is preserved when Git has no source object');
    assert.equal(fallback?.previousMode, undefined);
  } finally {
    await session.dispose();
  }
});
