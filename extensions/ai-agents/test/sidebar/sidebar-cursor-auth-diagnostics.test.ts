import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { commands, env, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor diagnostics use synthetic auth results and report SDK status failures without contacting auth services', async () => {
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

    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-in' }) });
    await harness.sidebar.showDiagnostics();
    const success = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(success, /Cursor SDK auth\nlogged-in/);
    assert.match(success, /OK Backend\ncursor\/sdk/);

    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => { throw new Error('synthetic auth status failure'); } });
    await harness.sidebar.showDiagnostics();
    const failure = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(failure, /FAIL Cursor SDK auth\nsynthetic auth status failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');

    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const routed = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(routed, /FAIL Cursor SDK auth\nsynthetic auth status failure/);
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});
