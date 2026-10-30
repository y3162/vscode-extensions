import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeFileChanges } from '../../src/change-review.js';
import { applyUndoAll, captureAcceptance, changeSetFingerprint, contentDigest, inspectUndoAll, projectReview } from '../../src/review-acceptance.js';
import type { FileChange } from '../../src/types.js';

const reasons = {
  checking: 'checking',
  conflict: 'conflict',
  unavailable: 'unavailable',
};

function change(file: string, previous: string, current: string, extra: Partial<FileChange> = {}): FileChange {
  return { path: file, kind: 'update', previousText: previous, observedDigest: contentDigest(current), ...extra };
}

test('keep records the current bytes and a later edit is a conflict, not a permanent accept', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-keep-'));
  const file = path.join(root, 'note.txt');
  try {
    await writeFile(file, 'after\n');
    const current = [change(file, 'before\n', 'after\n')];
    const captured = await captureAcceptance(current, [root]);
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.equal(captured.acceptance.digests[file], contentDigest('after\n'));
    assert.equal(projectReview(current, captured.acceptance, {
      fingerprint: captured.acceptance.fingerprint,
      digests: { [file]: contentDigest('after\n') },
      undoEnabled: true,
    }, reasons).status, 'accepted');
    await writeFile(file, 'user edit\n');
    const drifted = projectReview(current, captured.acceptance, {
      fingerprint: captured.acceptance.fingerprint,
      digests: { [file]: contentDigest('user edit\n') },
      undoEnabled: false,
      undoReason: 'drift',
    }, reasons);
    assert.equal(drifted.status, 'conflict');
    assert.equal(drifted.undoEnabled, false);
    assert.equal(drifted.keepEnabled, true);
    const revised = mergeFileChanges(current, [{ path: file, kind: 'update', diff: 'next' }]);
    assert.notEqual(changeSetFingerprint(revised), captured.acceptance.fingerprint);
    assert.equal(projectReview(revised, captured.acceptance, undefined, reasons).status, 'pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undo all restores only a fully checked set and refuses user edits, symlinks, and unsaved buffers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-undo-'));
  const file = path.join(root, 'note.txt');
  const other = path.join(root, 'other.txt');
  const link = path.join(root, 'link.txt');
  const outside = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-outside-'));
  try {
    await writeFile(file, 'after\n');
    await writeFile(other, 'second\n');
    await symlink(file, link);
    const safe = [change(file, 'before\n', 'after\n'), change(other, 'old\n', 'second\n')];
    assert.equal((await inspectUndoAll(safe, [root], new Set())).ok, true);
    await writeFile(file, 'user\n');
    const edited = await inspectUndoAll(safe, [root], new Set());
    assert.equal(edited.ok, false);
    assert.match(edited.blocks.map((block) => block.reason).join('\n'), /一致しない/);
    await writeFile(file, 'after\n');
    const dirty = await inspectUndoAll(safe, [root], new Set([file]));
    assert.equal(dirty.ok, false);
    assert.match(dirty.blocks.map((block) => block.reason).join('\n'), /未保存/);
    const linked = await inspectUndoAll([change(link, 'before\n', 'after\n')], [root], new Set());
    assert.equal(linked.ok, false);
    const escaped = await inspectUndoAll([change(path.join(outside, 'secret.txt'), 'before\n', 'after\n')], [root], new Set());
    assert.equal(escaped.ok, false);
    const missing = await inspectUndoAll([{ path: file, kind: 'update', previousText: 'before\n' }], [root], new Set());
    assert.equal(missing.ok, false);
    const renamed = await inspectUndoAll([{ path: file, kind: 'rename', oldPath: 'old.txt', previousText: 'before\n', observedDigest: contentDigest('after\n') }], [root], new Set());
    assert.equal(renamed.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('undo refuses a symlinked directory even when it points inside the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-alias-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  try {
    await mkdir(actual);
    await writeFile(path.join(actual, 'note.txt'), 'after');
    await symlink(actual, alias);
    const plan = await inspectUndoAll([change(path.join(alias, 'note.txt'), 'before', 'after')], [root], new Set());
    assert.equal(plan.ok, false);
    assert.match(plan.blocks[0]!.reason, /シンボリックリンク/);
    assert.equal(await readFile(path.join(actual, 'note.txt'), 'utf8'), 'after');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undo refuses a symlinked workspace root and detects dirty files through ancestor aliases', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-root-alias-'));
  const parent = path.join(base, 'parent');
  const workspace = path.join(parent, 'workspace');
  const alias = path.join(base, 'alias');
  const workspaceAlias = path.join(base, 'workspace-alias');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'note.txt'), 'after');
    await symlink(parent, alias);
    await symlink(workspace, workspaceAlias);
    const rootLink = await inspectUndoAll([change(path.join(workspaceAlias, 'note.txt'), 'before', 'after')], [workspaceAlias], new Set());
    assert.equal(rootLink.ok, false);
    assert.match(rootLink.blocks[0]!.reason, /シンボリックリンク/);
    const aliasedWorkspace = path.join(alias, 'workspace');
    const dirty = await inspectUndoAll([change(path.join(aliasedWorkspace, 'note.txt'), 'before', 'after')], [aliasedWorkspace], new Set([path.join(workspace, 'note.txt')]));
    assert.equal(dirty.ok, false);
    assert.match(dirty.blocks[0]!.reason, /未保存/);
    assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'after');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a partial undo reports the restored file and the failure separately', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-partial-'));
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  try {
    await writeFile(first, 'after\n');
    const result = await applyUndoAll([
      change(first, 'before\n', 'after\n'),
      change(second, 'before\n', 'after\n'),
    ], [root], async (item) => {
      if (item.path === second) throw new Error('disk full');
      await writeFile(item.path, item.previousText ?? '');
    });
    assert.deepEqual(result.restored, [first]);
    assert.equal(result.failed?.path, second);
    assert.match(result.failed?.message ?? '', /disk full/);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(first, 'utf8'), 'before\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undo revalidates each file and preserves a later external edit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-race-'));
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  try {
    await writeFile(first, 'after one');
    await writeFile(second, 'after two');
    const changes = [change(first, 'before one', 'after one'), change(second, 'before two', 'after two')];
    assert.equal((await inspectUndoAll(changes, [root], new Set())).ok, true);
    const result = await applyUndoAll(changes, [root], async (item) => {
      await writeFile(item.path, item.previousText ?? '');
      if (item.path === first) await writeFile(second, 'external edit');
    }, async (item) => {
      const plan = await inspectUndoAll([item], [root], new Set());
      if (!plan.ok) throw new Error(plan.blocks.map((block) => block.reason).join('\n'));
    });
    assert.deepEqual(result.restored, [first]);
    assert.equal(result.failed?.path, second);
    assert.match(result.failed?.message ?? '', /一致しない/);
    assert.equal(await readFile(first, 'utf8'), 'before one');
    assert.equal(await readFile(second, 'utf8'), 'external edit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance from one change set does not apply to another fingerprint', () => {
  const alpha = [change('/workspace/a.txt', 'a', 'A')];
  const beta = [change('/workspace/b.txt', 'b', 'B')];
  const acceptance = { fingerprint: changeSetFingerprint(alpha), digests: { '/workspace/a.txt': contentDigest('A') } };
  const probe = { fingerprint: changeSetFingerprint(beta), digests: { '/workspace/b.txt': contentDigest('B') }, undoEnabled: true };
  assert.equal(projectReview(beta, acceptance, probe, reasons).status, 'pending');
  assert.equal(projectReview([], undefined, undefined, reasons).status, 'pending');
});
