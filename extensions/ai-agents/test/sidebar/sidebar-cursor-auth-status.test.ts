import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor diagnostics distinguish an unauthenticated SDK status from a status request failure', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'not-logged-in' }) });

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /FAIL Cursor SDK auth\nnot-logged-in/);
    assert.match(report, /Backend\ncursor\/sdk/);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});
