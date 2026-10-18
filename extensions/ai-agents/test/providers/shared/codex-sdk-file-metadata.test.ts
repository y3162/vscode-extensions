import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createSession } from '../../../src/providers/index.js';

import type { AgentUpdate } from '../../../src/types.js';

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-final-'));
}

test('Codex preserves an absent previous-text field when no Git baseline exists', async () => {
  const cwd = await tempDirectory();
  const thread = {
    id: 'no-baseline-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield {
          type: 'item.completed',
          item: { id: 'new-file', type: 'file_change', status: 'completed', changes: [{ path: 'new.txt', kind: 'add', diff: '+new file\n' }] },
        } as never;
      })() };
    },
  };
  class FakeCodex {
    constructor(_options: unknown) {}
    startThread() { return thread; }
    resumeThread() { return thread; }
  }
  const loaders = {
    codex: async () => ({ Codex: FakeCodex }) as never,
    cursor: async () => { throw new Error('Cursor is not selected'); },
  };
  const session = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, loaders, true);
  try {
    const updates: AgentUpdate[] = [];
    await session.run!('add file', new AbortController().signal, (update) => updates.push(update));
    const change = updates.flatMap((update) => update.meta?.files ?? []).find((file) => file.path === 'new.txt');
    assert.ok(change);
    assert.equal(change.kind, 'add');
    assert.equal(Object.hasOwn(change, 'previousText'), false, 'missing source text stays absent instead of being fabricated');
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
