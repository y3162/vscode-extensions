import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { applyTextStats, captureGitBaselines, readWorkspaceText, refreshChangeStats } from '../../src/change-tracker.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test('workspace text and change stats reject escapes, symlinks, NUL, and size boundaries', async () => {
  const cwd = await tempDir('ai-agents-text-gap-');
  const outside = await tempDir('ai-agents-text-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  try {
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001), { mode: 0o640 });
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await symlink(secret, path.join(cwd, 'link.txt'));
    await mkdir(path.join(cwd, 'locked'));
    await writeFile(path.join(cwd, 'locked', 'hidden.txt'), 'hidden', { mode: 0o600 });
    await chmod(path.join(cwd, 'locked'), 0o000);
    assert.equal((await readWorkspaceText(cwd, 'exact.txt'))?.length, 500_000);
    assert.equal(await readWorkspaceText(cwd, 'over.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'nul.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'bad.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'link.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'missing.txt'), null);
    assert.equal(await readWorkspaceText(cwd, '../secret.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'locked/hidden.txt'), undefined);
    await chmod(path.join(cwd, 'locked'), 0o700);
    await writeFile(path.join(cwd, 'now.txt'), 'now\n', { mode: 0o640 });
    const huge = `${'a\n'.repeat(4001)}`;
    const refreshed = await refreshChangeStats(cwd, [
      { path: 'turn.diff', kind: 'update', diff: 'keep' },
      { path: 'patch', kind: 'update' },
      { path: 'now.txt', kind: 'update' },
      { path: 'now.txt', kind: 'update', previousText: 'old\n', previousMode: 0o644 },
      { path: 'missing.txt', kind: 'update', previousText: 'was\n' },
      { path: 'link.txt', kind: 'update', previousText: 'x' },
      { path: 'over.txt', kind: 'add', previousText: null },
      { path: 'wide.txt', kind: 'update', previousText: huge },
    ]);
    assert.equal(refreshed[0]?.diff, 'keep');
    assert.equal(refreshed[1]?.path, 'patch');
    assert.equal(refreshed[2]?.previousText, undefined);
    assert.equal(refreshed[3]?.kind, 'update');
    assert.equal(refreshed[3]?.additions, 1);
    assert.equal(refreshed[4]?.kind, 'delete');
    assert.equal(refreshed[5]?.previousText, 'x');
    assert.equal(refreshed[7]?.additions, undefined);
    const bare = { path: 'a', kind: 'update' as const };
    assert.equal(applyTextStats(bare, 'x'), bare);
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: null }, 'x').kind, 'add');
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: 'x' }, null).kind, 'delete');
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: 'x' }, undefined).kind, 'update');
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
    assert.equal((await stat(path.join(cwd, 'exact.txt'))).mode & 0o777, 0o640);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});;
