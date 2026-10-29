import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
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

test('acceptance from one change set does not apply to another fingerprint', () => {
  const alpha = [change('/workspace/a.txt', 'a', 'A')];
  const beta = [change('/workspace/b.txt', 'b', 'B')];
  const acceptance = { fingerprint: changeSetFingerprint(alpha), digests: { '/workspace/a.txt': contentDigest('A') } };
  const probe = { fingerprint: changeSetFingerprint(beta), digests: { '/workspace/b.txt': contentDigest('B') }, undoEnabled: true };
  assert.equal(projectReview(beta, acceptance, probe, reasons).status, 'pending');
  assert.equal(projectReview([], undefined, undefined, reasons).status, 'pending');
});
