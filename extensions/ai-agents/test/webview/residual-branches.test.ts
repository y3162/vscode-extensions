import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { presentChange, toViewMessage, diffMessages } from '../../src/view-state.js';
import { createDom } from '../../src/webview/dom.js';
import { Header } from '../../src/webview/header.js';
import { Menu, ModelMenu } from '../../src/webview/popover.js';
import { parseMarkdown, renderInline } from '../../src/webview/markdown.js';
import { strings } from '../../src/webview/strings.js';
import type { ViewShell } from '../../src/protocol.js';

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

test('menus use documented viewport defaults when a document has no window', () => {
  const document = new Window().document.implementation.createHTMLDocument('detached');
  assert.equal(document.defaultView, null);
  const dom = createDom(document);
  const trigger = dom.button('trigger', 'Open');
  document.body.append(trigger);

  const menu = new Menu(dom, document.body);
  menu.open(trigger, [{ id: 'one', label: 'One', onSelect() {} }]);
  assert.equal(menu.element.style.left, '8px');
  assert.equal(menu.element.style.top, '6px');

  const modelMenu = new ModelMenu(dom, document.body);
  modelMenu.open(trigger, {
    items: [{ id: 'models', label: 'Models', submenu: () => ({ items: [{ id: 'model', label: 'Model' }] }) }],
  });
  modelMenu.element.querySelector<HTMLButtonElement>('[data-id="models"]')?.click();
  assert.equal(modelMenu.isOpen, true);
  assert.equal(modelMenu.element.querySelector('[data-id="back"]'), null);
  assert.equal(document.querySelector('.submenu')?.hidden, false);
  assert.equal((document.querySelector('.submenu') as HTMLElement).style.left, '4px');
  menu.close(false);
  modelMenu.close(false);
});

test('header uses provider fallback when a restored shell has no provider labels', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const header = new Header(dom, root, strings('en'), () => {}, () => {}, () => {}, () => {}, () => {});
  const shell = {
    provider: 'cursor', providers: [], busy: false, terminals: [], sessionTitle: 'Restored', statusText: 'Ready',
  } as unknown as ViewShell;

  header.render(shell, strings('en'), 'home');
  assert.equal(root.querySelector('.provider')?.getAttribute('aria-label'), 'Cursor');
  assert.equal(root.querySelector('.title-pill')?.textContent, 'Restored');
});

test('view projection marks outside absolute changes synthetic and removes stale message ids', () => {
  const outside = presentChange({ path: '/outside/secret.txt', kind: 'update', diff: '+secret\n' }, ['/workspace']);
  assert.equal(outside.synthetic, true);
  assert.equal(outside.name, 'Patch');
  assert.equal(outside.canRevert, false);
  assert.equal(outside.patch, '+secret\n');

  const user = toViewMessage({ id: 'user', role: 'user', text: 'prompt' });
  assert.equal(user.canRewind, false);
  const diff = diffMessages(new Map([['old', '{"id":"old"}']]), []);
  assert.deepEqual(diff.removed, ['old']);
  assert.deepEqual(diff.upserts, []);
  assert.deepEqual(diff.order, []);
});
