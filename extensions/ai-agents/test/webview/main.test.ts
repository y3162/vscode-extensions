import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('the webview entry creates the app from acquireVsCodeApi', async () => {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  const previousDocument = globalThis.document;
  const previousAcquire = (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  Object.assign(globalThis, {
    document: window.document,
    acquireVsCodeApi: () => ({
      postMessage(message: unknown) { sent.push(message); },
      getState: () => null,
      setState() {},
    }),
  });
  try {
    await import('../../src/webview/main.js');
    assert.equal(sent.some((message) => message && typeof message === 'object' && 'type' in message && message.type === 'ready'), true);
    assert.equal(window.document.querySelector('#app')?.classList.contains('shell'), true);
    assert.equal(window.document.querySelector('.dock')?.hidden, true);
  } finally {
    Object.assign(globalThis, { document: previousDocument, acquireVsCodeApi: previousAcquire });
  }
});
