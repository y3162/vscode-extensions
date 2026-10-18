import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Menu } from '../../src/webview/popover.js';

test('menu ArrowUp moves from the second entry back to the first', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  root.append(trigger);
  window.document.body.append(root);
  const menu = new Menu(dom, root);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'second', label: 'Second', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="second"]')?.classList.contains('active'), true);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="first"]')?.classList.contains('active'), true);
  menu.close(false);
  window.happyDOM.abort();
});
