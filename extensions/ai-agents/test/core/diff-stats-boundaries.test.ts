import assert from 'node:assert/strict';

import { test } from 'node:test';

import { lineChangeCounts, previewTextDiff, previousTextFromDiff } from '../../src/diff-stats.js';

test('diff helpers preserve empty-file newline changes and reject partial deletion baselines', () => {
  assert.deepEqual(previewTextDiff('', '\n'), [
    { kind: 'add', line: 1, text: '' },
  ]);
  assert.deepEqual(lineChangeCounts('\n', ''), { additions: 0, deletions: 1 });
  assert.equal(
    previousTextFromDiff('@@ -1,2 +0,0 @@\n-secret\n context\n', 'delete'),
    undefined,
    'a deletion hunk with context is incomplete and cannot be used as a restore baseline',
  );
});;
