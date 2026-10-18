import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

test('popover wraps ArrowUp, ignores keys after close, and safely handles a targetless synthetic pointer event', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  root.append(trigger);
  window.document.body.append(root);
  const menu = new Menu(dom, root);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);
  const pointer = menu as unknown as { onPointer(event: Event): void };
  pointer.onPointer(new window.Event('pointerdown'));
  assert.equal(menu.isOpen, true, 'an undispatched event has no target and cannot close the menu');
  menu.close(false);
  const hiddenKey = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  menu.element.dispatchEvent(hiddenKey);
  assert.equal(hiddenKey.defaultPrevented, false);

  const model = new ModelMenu(dom, root);
  model.open(trigger, { items: [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ] });
  model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(model.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);
  const modelPointer = model as unknown as { onPointer(event: Event): void };
  modelPointer.onPointer(new window.Event('pointerdown'));
  assert.equal(model.isOpen, true);
  model.close(false);
  const hiddenModelKey = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  model.element.dispatchEvent(hiddenModelKey);
  assert.equal(hiddenModelKey.defaultPrevented, false);
  window.happyDOM.abort();
});
