import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

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


test('a wide context menu stays inside a narrow viewport', () => {
  const window = new Window({ width: 320, height: 800 });
  const dom = createDom(window.document);
  const trigger = dom.button('trigger', 'Open');
  window.document.body.append(trigger);
  trigger.getBoundingClientRect = () => ({ left: 280, right: 308, top: 600, bottom: 628, width: 28, height: 28, x: 280, y: 600, toJSON() {} });
  const menu = new Menu(dom, window.document.body);
  menu.element.getBoundingClientRect = () => ({ left: 0, right: 300, top: 634, bottom: 934, width: 300, height: 300, x: 0, y: 634, toJSON() {} });
  menu.open(trigger, [{ id: 'one', label: 'A long workspace path', onSelect() {} }]);
  assert.equal(menu.element.style.left, '12px');
  assert.equal(menu.element.style.top, 'auto');
  assert.equal(menu.element.style.bottom, '206px');
  menu.close(true);
  assert.equal(window.document.activeElement, trigger);
  window.happyDOM.abort();
});
