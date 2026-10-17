import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isRealPathInsideWorkspace, mergeFileChanges, revertChange } from '../../src/change-review.js';

test('merge fills a missing rename origin while keeping the first captured baseline', () => {
  const merged = mergeFileChanges(
    [{ path: 'new.txt', kind: 'update', previousText: 'before', previousMode: 0o640 }],
    [{ path: 'new.txt', kind: 'rename', oldPath: 'old.txt', previousText: 'later', previousMode: 0o755 }],
  );
  assert.deepEqual(merged, [{
    path: 'new.txt', kind: 'rename', oldPath: 'old.txt', previousText: 'before', previousMode: 0o640,
    mode: undefined, diff: undefined, preview: undefined, additions: undefined, deletions: undefined,
  }]);
});

test('an incomplete rename is refused without changing either path', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rename-incomplete-'));
  const moved = path.join(cwd, 'new.txt');
  try {
    await writeFile(moved, 'agent content');
    await assert.rejects(revertChange({ path: moved, kind: 'rename' }, [cwd]), /変更前のパスと内容が無いため/);
    await assert.rejects(revertChange({ path: moved, oldPath: 'old.txt', kind: 'rename' }, [cwd]), /変更前のパスと内容が無いため/);
    assert.equal(await readFile(moved, 'utf8'), 'agent content');
    await assert.rejects(readFile(path.join(cwd, 'old.txt')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rename restoration refuses an original path that resolves outside the workspace', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rename-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ai-agents-rename-target-'));
  const moved = path.join(cwd, 'new.txt');
  const outsideFile = path.join(outside, 'keep.txt');
  try {
    await writeFile(moved, 'agent content');
    await writeFile(outsideFile, 'user content');
    await symlink(outsideFile, path.join(cwd, 'old-link.txt'));
    await assert.rejects(revertChange({
      path: moved, oldPath: 'old-link.txt', kind: 'rename', previousText: 'captured baseline',
    }, [cwd]), /ワークスペース外/);
    assert.equal(await readFile(moved, 'utf8'), 'agent content');
    assert.equal(await readFile(outsideFile, 'utf8'), 'user content');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('real path containment refuses lexical escapes and stops at the filesystem root on ENOENT', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-realpath-boundary-'));
  let attempts = 0;
  const missing = async () => {
    attempts += 1;
    throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
  };
  try {
    assert.equal(await isRealPathInsideWorkspace(path.resolve(cwd, '../outside.txt'), [cwd]), false);
    assert.equal(await isRealPathInsideWorkspace(path.join(cwd, 'missing', 'file.txt'), [cwd], missing), false);
    assert.ok(attempts > 1, 'the synthetic resolver exercised the ancestor walk through its root boundary');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('text restore accepts a missing destination but refuses to replace a directory and cleans its temporary file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-restore-target-'));
  const missing = path.join(cwd, 'missing.txt');
  const directory = path.join(cwd, 'directory');
  try {
    await revertChange({ path: missing, kind: 'update', previousText: 'baseline\n' }, [cwd]);
    assert.equal(await readFile(missing, 'utf8'), 'baseline\n');
    await mkdir(directory);
    await assert.rejects(revertChange({ path: directory, kind: 'update', previousText: 'must not replace directory' }, [cwd]), /通常ファイル/);
    assert.equal((await readdir(cwd)).some((name) => name.includes('.ai-agents-revert-')), false);
    await assert.rejects(readFile(directory, 'utf8'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
