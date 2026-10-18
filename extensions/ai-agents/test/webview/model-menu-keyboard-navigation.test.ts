import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('model menu wraps focus and drills when both sides lack room at a normal viewport width', () => {
  const window = new Window();
  window.innerWidth = 800;
  const dom = createDom(window.document);
  const host = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  host.append(trigger);
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="first"]')?.classList.contains('active'), true);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);

  const model = new ModelMenu(dom, host);
  model.open(trigger, { items: [{ id: 'more', label: 'More', submenu: () => ({ items: [{ id: 'child', label: 'Child' }] }) }] });
  Object.defineProperty(model.element, 'getBoundingClientRect', { value: () => ({ left: 150, right: 700, top: 560, bottom: 590, width: 550, height: 30 }) });
  model.element.querySelector<HTMLButtonElement>('[data-id="more"]')!.click();
  assert.equal(model.element.querySelector('[data-id="back"] .menu-label')?.textContent, 'Back');
  assert.equal(model.element.querySelector('.menu-back') !== null, true);
  assert.equal((host.querySelector('.submenu') as HTMLElement).hidden, true);
  model.close(false);
  model.element.remove();
  host.querySelector('.submenu')?.remove();

  const overflow = new ModelMenu(dom, host);
  overflow.open(trigger, { items: [{ id: 'more', label: 'More', submenu: () => ({ items: [{ id: 'child', label: 'Child' }] }) }] });
  Object.defineProperty(overflow.element, 'getBoundingClientRect', { value: () => ({ left: 600, right: 790, top: 20, bottom: 50, width: 190, height: 30 }) });
  overflow.element.querySelector<HTMLButtonElement>('[data-id="more"]')!.click();
  assert.equal((host.querySelector('.submenu') as HTMLElement).hidden, false);
  assert.equal((host.querySelector('.submenu') as HTMLElement).style.left, '376px');
  overflow.close(false);
  menu.close(false);
  window.happyDOM.abort();
});
