import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLocation } from '../../../src/providers/read-location.js';

test('read locations prefer structured fields, then the target, then a Read label', () => {
  assert.deepEqual(readLocation('Read README.md L1-51'), { path: 'README.md', line: 1, endLine: 51 });
  assert.deepEqual(readLocation('Open "src/a.ts" L2–L4'), { path: 'src/a.ts', line: 2, endLine: 4 });
  assert.deepEqual(readLocation("Read 'src/b.ts'"), { path: 'src/b.ts' });
  assert.deepEqual(readLocation('Read the file'), {});
  assert.deepEqual(readLocation('Read files'), {});
  assert.deepEqual(readLocation('Read file'), {});
  assert.deepEqual(readLocation('note', 'src/a.ts L3-L9', { path: ' explicit.ts ', line: '4', endLine: '8' }), {
    path: 'explicit.ts', line: 4, endLine: 8,
  });
  assert.deepEqual(readLocation('Read src/b.ts', undefined, { filePath: 'c.ts' }), { path: 'c.ts' });
  assert.deepEqual(readLocation('x', undefined, { file_path: 'd.ts' }), { path: 'd.ts' });
  assert.deepEqual(readLocation('x', undefined, { filename: 'e.ts' }), { path: 'e.ts' });
  assert.deepEqual(readLocation('x', undefined, { uri: 'f.ts' }), { path: 'f.ts' });
  assert.deepEqual(readLocation('x', '   ', { path: '  ', filePath: '', filename: '   ' }), {});
  assert.deepEqual(readLocation('x', undefined, null), {});
  assert.deepEqual(readLocation('x', undefined, ['path']), {});
  assert.deepEqual(readLocation('plain', undefined, { unrelated: 1 }), {});
  assert.deepEqual(readLocation('x', undefined, { startLine: 2, end_line: '9' }), { line: 2, endLine: 9 });
  assert.deepEqual(readLocation('x', undefined, { line: '9007199254740993', start_line: 0, fromLine: 3, toLine: 1.5, to_line: 4 }), {
    line: 3, endLine: 4,
  });
  assert.deepEqual(readLocation('x', undefined, { from_line: '12' }), { line: 12 });
  assert.deepEqual(readLocation('Read src/a.ts L10', 'other.ts L2-3'), { path: 'other.ts', line: 10, endLine: 3 });
  assert.deepEqual(readLocation('Read', 'src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(readLocation('x', ' L12-L14'), { line: 12, endLine: 14 });
  assert.deepEqual(readLocation('', '', undefined), {});
});
