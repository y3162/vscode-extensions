import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

test('app uses global event hooks when given a document without a window', () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument('detached');
  const oldAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const oldRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  const added: string[] = [];
  const removed: string[] = [];
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: (type: string) => added.push(type) });
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: (type: string) => removed.push(type) });
  try {
    const app = createApp({ postMessage() {}, getState: () => null, setState() {} }, { document });
    assert.deepEqual(added, ['keydown', 'message']);
    app.destroy();
    assert.deepEqual(removed, ['keydown', 'message']);
  } finally {
    if (oldAdd) Object.defineProperty(globalThis, 'addEventListener', oldAdd);
    else Reflect.deleteProperty(globalThis, 'addEventListener');
    if (oldRemove) Object.defineProperty(globalThis, 'removeEventListener', oldRemove);
    else Reflect.deleteProperty(globalThis, 'removeEventListener');
    sourceWindow.happyDOM.abort();
  }
});
