import assert from 'node:assert/strict';

import { test } from 'node:test';

import { parseMarkdown, renderInline } from '../../src/webview/markdown.js';

test('markdown parser preserves malformed and mixed block boundaries', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('```ts\nconst value = 1'), [
    { type: 'code', lang: 'ts', code: 'const value = 1', closed: false },
  ]);
  assert.deepEqual(parseMarkdown('> quoted\n\nplain\n\n- bullet\n1. numbered'), [
    { type: 'quote', text: 'quoted' },
    { type: 'paragraph', text: 'plain' },
    { type: 'list', ordered: false, items: ['bullet'] },
    { type: 'list', ordered: true, items: ['numbered'] },
  ]);
  assert.deepEqual(parseMarkdown('| this is not a table without its separator |'), [
    { type: 'paragraph', text: '| this is not a table without its separator |' },
  ]);
});
