import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('terminal open and terminate routes ignore a missing processId without touching session state', async () => {
  resetVscode();
  const harness = openSidebar();
  const before = harness.sidebar.controller.snapshot();
  try {
    await harness.sidebar.handleMessage({ type: 'openTerminal' });
    await harness.sidebar.handleMessage({ type: 'terminateTerminal' });

    assert.deepEqual(harness.sidebar.controller.snapshot(), before);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(window.terminals.length, 0);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
