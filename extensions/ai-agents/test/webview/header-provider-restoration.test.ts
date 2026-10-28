import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Header } from '../../src/webview/header.js';

import { strings } from '../../src/webview/strings.js';

import type { ViewShell } from '../../src/protocol.js';

test('header uses provider fallback when a restored shell has no provider labels', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const header = new Header(dom, root, strings('en'), () => {}, () => {}, () => {}, () => {});
  const shell = {
    provider: 'cursor', providers: [], busy: false, terminals: [], sessionTitle: 'Restored', statusText: 'Ready',
  } as unknown as ViewShell;

  header.render(shell, strings('en'), 'home');
  assert.equal(root.querySelector('.provider')?.getAttribute('aria-label'), 'Cursor');
  assert.equal(root.querySelector('.title-pill')?.textContent, 'Restored');
});
