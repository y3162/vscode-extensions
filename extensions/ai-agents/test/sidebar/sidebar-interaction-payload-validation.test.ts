import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('malformed permission and question payloads cannot grant access or crash the interaction route', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const permission = harness.sidebar.controller.interactions.requestPermission({ id: 'guarded-shell', title: 'Run command', detail: 'rm -rf temp', kind: 'shell' });
    await settle();
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 7, decision: 'allow-session' });
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-shell', decision: 'approve' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission?.id, 'guarded-shell');
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'guarded-shell', decision: 'deny' });
    assert.equal(await permission, 'deny');
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission, null);

    const answers = harness.sidebar.controller.interactions.requestAnswers({
      id: 'guarded-question', questions: [{ id: 'confirm', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
    });
    await settle();
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 'guarded-question', answers: 'invalid-shape' });
    assert.deepEqual(await answers, {});
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion, null);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
