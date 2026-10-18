import assert from 'node:assert/strict';

import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { captureBaseline, revertChange } from '../../src/change-review.js';

import type { FileChange } from '../../src/types.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test('baseline capture falls back to non-restorable metadata when file contents are unreadable', async () => {
  const cwd = await temporaryDirectory('ai-agents-baseline-unreadable-');
  const file = path.join(cwd, 'locked.txt');
  const store = new Map<string, FileChange>();
  await writeFile(file, 'user content\n', { mode: 0o600 });

  try {
    await chmod(file, 0);
    await captureBaseline(cwd, 'locked.txt', store);

    const baseline = store.get(file);
    assert.deepEqual(baseline, { path: file, kind: 'update' });
    assert.equal((await lstat(file)).mode & 0o777, 0);
    await chmod(file, 0o600);
    assert.equal(await readFile(file, 'utf8'), 'user content\n');
  } finally {
    await chmod(file, 0o600).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('reverting an added file removes it safely and remains idempotent', async () => {
  const cwd = await temporaryDirectory('ai-agents-revert-added-');
  const outside = await temporaryDirectory('ai-agents-revert-outside-');
  const added = path.join(cwd, 'agent-added.txt');
  const sentinel = path.join(outside, 'sentinel.txt');
  await writeFile(added, 'agent output\n');
  await writeFile(sentinel, 'user data\n', { mode: 0o640 });

  try {
    const change: FileChange = { path: added, kind: 'add', previousText: null, previousMode: null };
    await revertChange(change, [cwd]);
    await assert.rejects(readFile(added, 'utf8'), { code: 'ENOENT' });
    await revertChange(change, [cwd]);
    assert.equal(await readFile(sentinel, 'utf8'), 'user data\n');
    assert.equal((await lstat(sentinel)).mode & 0o777, 0o640);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
