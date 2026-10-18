import assert from 'node:assert/strict';

import path from 'node:path';

import { test } from 'node:test';

import { countUnifiedDiff, extensionBadge, lineChangeCounts, normalizeChangeKind, parseUnifiedDiff, previewTextDiff, previewUnifiedDiff, previousTextFromDiff } from '../../src/diff-stats.js';

test('diff helpers cover size boundaries, renames, empty deletions, and omitted hunks', () => {
  const fourThousand = `${'a\n'.repeat(4000)}`;
  const fourThousandOne = `${'a\n'.repeat(4001)}`;
  assert.deepEqual(lineChangeCounts(fourThousand, fourThousand), { additions: 0, deletions: 0 });
  assert.equal(lineChangeCounts(fourThousandOne, 'a\n'), undefined);
  assert.deepEqual(lineChangeCounts('', ''), { additions: 0, deletions: 0 });
  assert.deepEqual(previewTextDiff('same', 'same\n'), [
    { kind: 'context', line: 1, text: 'same' },
    { kind: 'eof', text: 'Newline at end of file' },
  ]);
  assert.deepEqual(previewTextDiff('same\n', 'same'), [
    { kind: 'context', line: 1, text: 'same' },
    { kind: 'eof', text: 'No newline at end of file' },
  ]);
  assert.deepEqual(previewTextDiff(null, ''), []);
  assert.deepEqual(previewTextDiff('', null), []);
  assert.deepEqual(previewTextDiff('old\r\n', 'new\r\n').map((row) => row.text), ['old', 'new']);
  assert.deepEqual(countUnifiedDiff('diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n'), { additions: 1, deletions: 1 });
  const crowded = previewTextDiff(['keep', ...'abcde'.split(''), 'tail'].join('\n'), ['keep', ...'ABCDE'.split(''), 'tail'].join('\n'), 2);
  assert.equal(crowded.filter((row) => row.kind === 'more').length, 2);
  assert.equal(crowded.at(-1)?.text, 'tail');
  assert.deepEqual(previewUnifiedDiff('no hunks'), []);
  assert.deepEqual(previewUnifiedDiff('@@ -1 +1 @@\n context\n'), []);
  const many = ['@@ -1,30 +1,30 @@', ' context', ...Array.from({ length: 20 }, (_item, index) => `-${index}`), ...Array.from({ length: 20 }, (_item, index) => `+${index}`), ' context'].join('\n');
  const preview = previewUnifiedDiff(many, 6);
  assert.equal(preview.some((row) => row.kind === 'more'), true);
  assert.equal(preview.length <= 6, true);
  const noEdgeContext = previewUnifiedDiff(['@@ -1,40 +1,40 @@', ...Array.from({ length: 20 }, (_item, index) => `-old${index}`), ...Array.from({ length: 20 }, (_item, index) => `+new${index}`)].join('\n'), 6);
  assert.equal(noEdgeContext.some((row) => row.kind === 'context'), false);
  assert.equal(noEdgeContext.some((row) => row.kind === 'more'), true);
  assert.equal(noEdgeContext.length <= 6, true);
  assert.equal(previewUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n').some((row) => row.kind === 'eof'), true);
  assert.equal(parseUnifiedDiff('   ').length, 0);
  const plain = parseUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(plain[0]?.path, 'x.ts');
  assert.equal(plain[0]?.kind, 'update');
  const removed = parseUnifiedDiff('diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n');
  assert.equal(removed[0]?.kind, 'delete');
  const added = parseUnifiedDiff('diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n');
  assert.equal(added[0]?.kind, 'add');
  const renamed = parseUnifiedDiff('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(renamed[0]?.kind, 'rename');
  assert.equal(renamed[0]?.oldPath, 'old.ts');
  assert.equal(parseUnifiedDiff('--- /dev/null\n+++ /dev/null\n').length, 0);
  assert.equal(normalizeChangeKind('move').kind, 'rename');
  assert.equal(normalizeChangeKind('bogus').kind, 'update');
  assert.equal(normalizeChangeKind(null).kind, 'update');
  assert.deepEqual(normalizeChangeKind({ type: 'update', movePath: 'from.ts' }), { kind: 'rename', movePath: 'from.ts' });
  assert.deepEqual(normalizeChangeKind({ type: 'move' }), { kind: 'rename' });
  assert.deepEqual(normalizeChangeKind({ type: 'other', move_path: 'from.ts' }), { kind: 'update', oldPath: 'from.ts' });
  assert.deepEqual(normalizeChangeKind({}), { kind: 'update' });
  assert.deepEqual(normalizeChangeKind({ type: 'other' }), { kind: 'update' });
  assert.equal(normalizeChangeKind({ type: 'delete' }).kind, 'delete');
  assert.equal(previousTextFromDiff('diff --git a/e.txt b/e.txt\ndeleted file mode 100644\n--- a/e.txt\n+++ /dev/null\n', 'delete'), '');
  assert.equal(previousTextFromDiff('@@ -1 +0,0 @@\n', 'delete'), undefined);
  assert.equal(previousTextFromDiff('@@ -1 +0,0 @@\n context\n', 'delete'), undefined);
  assert.equal(previousTextFromDiff('@@ -1 +1 @@\n-a\n', 'rename'), undefined);
  assert.equal(extensionBadge('dir/file.ts'), 'TS');
  assert.equal(extensionBadge('Makefile'), 'MAKE');
  assert.equal(extensionBadge('.gitignore'), '.GIT');
  assert.equal(extensionBadge('a.toolong'), 'TOOL');
  assert.equal(extensionBadge(''), 'FILE');
  assert.equal(extensionBadge('a.'), 'FILE');
});;
