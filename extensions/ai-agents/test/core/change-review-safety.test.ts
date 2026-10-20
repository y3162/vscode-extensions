import { createGitFixture, snapshotGitFixture } from '../support/git-fixture.js';
import assert from 'node:assert/strict';


import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { captureBaseline, gitApplyReverse, isInsideWorkspace, mergeFileChanges, revertChange } from '../../src/change-review.js';

import { applyTextStats, captureGitBaselines, readWorkspaceText, refreshChangeStats } from '../../src/change-tracker.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test('baselines and revert refuse symlink escapes, oversized files, empty diffs, and failed applies', async () => {
  const cwd = await tempDir('ai-agents-review-gap-');
  const outside = await tempDir('ai-agents-review-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  try {
    const store = new Map<string, import('../../src/types.js').FileChange>();
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001));
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await symlink(secret, path.join(cwd, 'link.txt'));
    await captureBaseline(cwd, 'exact.txt', store);
    await captureBaseline(cwd, 'exact.txt', store);
    await writeFile(path.join(cwd, 'exact.txt'), 'changed');
    assert.equal(store.get(path.resolve(cwd, 'exact.txt'))?.previousText?.length, 500_000);
    await captureBaseline(cwd, 'over.txt', store);
    await captureBaseline(cwd, 'nul.txt', store);
    await captureBaseline(cwd, 'bad.txt', store);
    await captureBaseline(cwd, 'link.txt', store);
    await captureBaseline(cwd, 'missing.txt', store);
    await captureBaseline(cwd, '../secret.txt', store);
    assert.equal(store.has(path.resolve(cwd, '../secret.txt')), false);
    assert.equal(store.get(path.resolve(cwd, 'over.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'nul.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'bad.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'link.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'missing.txt'))?.kind, 'add');
    assert.equal(store.get(path.resolve(cwd, 'missing.txt'))?.previousText, null);
    await mkdir(path.join(cwd, 'locked'));
    await chmod(path.join(cwd, 'locked'), 0o000);
    await captureBaseline(cwd, 'locked/file.txt', store);
    assert.equal(store.get(path.resolve(cwd, 'locked/file.txt'))?.previousText, undefined);
    await chmod(path.join(cwd, 'locked'), 0o700);
    assert.equal(await captureGitBaselines(cwd), undefined);
    await writeFile(path.join(cwd, 'note.txt'), 'changed\n', { mode: 0o640 });
    await assert.rejects(revertChange({ path: path.join(cwd, 'link.txt'), kind: 'update', previousText: 'nope' }, [cwd]), /通常ファイル|ワークスペース外/);
    await assert.rejects(gitApplyReverse('  \n', cwd, [cwd]), /変更前の内容が無い/);
    await assert.rejects(gitApplyReverse('diff --git a/../secret.txt b/../secret.txt\n--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-secret\n+nope\n', cwd, [cwd]), /ワークスペース外/);
    await rm(path.join(cwd, 'link.txt'), { force: true });
    createGitFixture(cwd);
    await writeFile(path.join(cwd, 'exec.sh'), 'echo ok\n', { mode: 0o755 });
    await writeFile(path.join(cwd, 'plain.txt'), 'head\n', { mode: 0o644 });
    await symlink('plain.txt', path.join(cwd, 'inside-link.txt'));
    snapshotGitFixture(cwd);
    const baselines = await captureGitBaselines(cwd);
    assert.ok(baselines);
    assert.equal(await baselines.lookupMode('exec.sh'), 0o755);
    assert.equal(await baselines.lookupMode('plain.txt'), 0o644);
    assert.equal(await baselines.lookupMode('inside-link.txt'), undefined);
    assert.notEqual(await baselines.lookup('inside-link.txt'), 'secret');
    assert.equal(await baselines.lookup('../secret.txt'), undefined);
    await rm(path.join(cwd, 'plain.txt'));
    await writeFile(path.join(cwd, 'added.txt'), 'new\n', { mode: 0o644 });
    const changes = await baselines.changes();
    assert.equal(changes.find((change) => change.path === 'plain.txt')?.kind, 'delete');
    assert.equal(changes.find((change) => change.path === 'added.txt')?.kind, 'add');
    assert.equal(changes.find((change) => change.path === 'added.txt')?.previousText, null);
    await writeFile(path.join(cwd, 'plain.txt'), 'changed\n');
    const applied = 'diff --git a/plain.txt b/plain.txt\n--- a/plain.txt\n+++ b/plain.txt\n@@ -1 +1 @@\n-head\n+changed\n';
    await revertChange({ path: 'plain.txt', kind: 'update', diff: applied }, [cwd]);
    assert.equal(await readFile(path.join(cwd, 'plain.txt'), 'utf8'), 'head\n');
    await writeFile(path.join(cwd, 'plain.txt'), 'other\n');
    await assert.rejects(gitApplyReverse(applied, cwd, [cwd]));
    assert.equal(await readFile(path.join(cwd, 'plain.txt'), 'utf8'), 'other\n');
    await assert.rejects(revertChange({ path: 'nope.txt', kind: 'update', diff: '' }, [cwd]), /変更前の内容が無い|ENOENT/);
    const merged = mergeFileChanges(
      [{ path: 'a.ts', kind: 'rename', oldPath: 'old.ts', previousText: 'first', previousMode: 0o644, diff: 'old', additions: 1 }],
      [{ path: 'a.ts', kind: '' as 'update', oldPath: 'other.ts', previousText: 'second', previousMode: 0o755, mode: 0o755, diff: '', preview: [], deletions: 2 }],
    );
    assert.equal(merged[0]?.kind, 'rename');
    assert.equal(merged[0]?.oldPath, 'old.ts');
    assert.equal(merged[0]?.previousText, 'first');
    assert.equal(merged[0]?.previousMode, 0o644);
    assert.equal(merged[0]?.diff, 'old');
    const moved = path.join(cwd, 'moved.txt');
    await writeFile(moved, 'now');
    await revertChange({ path: moved, oldPath: 'restored.txt', kind: 'rename', previousText: 'back\n', previousMode: 0o750 }, [cwd]);
    assert.equal(await readFile(path.join(cwd, 'restored.txt'), 'utf8'), 'back\n');
    assert.equal((await stat(path.join(cwd, 'restored.txt'))).mode & 0o777, 0o750);
    await assert.rejects(readFile(moved, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
    assert.equal(isInsideWorkspace(cwd, [cwd]), true);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});;
