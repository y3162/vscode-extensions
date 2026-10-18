import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { parseMarkdown, renderInline } from '../../src/webview/markdown.js';

test('inline markdown keeps external links safe and leaves unknown URI schemes inert', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  renderInline(host, '[web](https://example.test/a) [unsafe](javascript:alert) [file](src/my%20file.ts:12:4)', dom);

  const web = host.querySelector('a');
  assert.equal(web?.href, 'https://example.test/a');
  assert.equal(web?.rel, 'noreferrer noopener');
  assert.equal(host.querySelectorAll('a').length, 1);
  assert.equal(host.querySelectorAll('button.file-link').length, 1);
  const file = host.querySelector<HTMLButtonElement>('button.file-link');
  assert.equal(file?.dataset.path, 'src/my file.ts');
  assert.equal(file?.dataset.line, '12');
  assert.equal(file?.dataset.column, '4');
  assert.match(host.textContent ?? '', /\[unsafe\]\(javascript:alert\)/);
});
