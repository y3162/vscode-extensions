import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('malformed webview messages with missing or invalid fields have no side effects', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.context.workspaceState.update('ai-agents.dismissedWarning', 'keep-warning');
    const before = harness.sidebar.controller.snapshot();
    const posted = view.messages.length;

    await harness.sidebar.handleMessage(null, view as never);
    await harness.sidebar.handleMessage('invalid payload', view as never);
    await harness.sidebar.handleMessage({}, view as never);
    await harness.sidebar.handleMessage({ type: 'dismissWarning' }, view as never);
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'probeResult', turns: '0', pending: false, history: false, settings: false }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry' }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'missing-user-id' }, view as never);

    assert.deepEqual(harness.sidebar.controller.snapshot(), before);
    assert.equal(harness.context.workspaceState.get('ai-agents.dismissedWarning'), 'keep-warning');
    assert.equal(view.messages.length, posted, 'invalid payloads do not post a retry or altered state');
  } finally {
    await close(harness);
  }
});
