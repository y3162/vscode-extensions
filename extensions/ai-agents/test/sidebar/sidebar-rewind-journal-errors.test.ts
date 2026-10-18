import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { resetVscode, env, window } from '../support/vscode-stub.js';

import { createView, openSidebar, settle, type Harness, type TestView } from '../support/vscode-harness.js';

async function ready(sidebar: Harness['sidebar'], view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a rewind-journal directory error is reported while the sidebar remains usable', async () => {
  resetVscode();
  const harness = openSidebar(({ context }) => {
    const history = path.join(context.storageUri.fsPath, 'history', 'v1');
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, 'rewind-journals'), 'not a directory');
  });
  try {
    const view = createView();
    await ready(harness.sidebar, view);
    await settle();
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('ENOTDIR')));
    await harness.sidebar.handleMessage({ type: 'logs' });
    assert.equal(harness.output.shown, true);
    assert.ok(window.errorMessages.length === 0);
  } finally {
    await close(harness);
  }
});
