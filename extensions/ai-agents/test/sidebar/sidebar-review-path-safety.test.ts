import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('reviewChanges skips paths outside the workspace and changes without a saved baseline', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [
      { path: '../outside.txt', kind: 'update', previousText: 'must not be exposed' },
      { path: 'no-baseline.txt', kind: 'update' },
      { path: 'patch', kind: 'update', previousText: 'synthetic protocol patch' },
    ];
    harness.sidebar.controller.restoreSnapshot(state);
    commands.executed.length = 0;

    await harness.sidebar.handleMessage({ type: 'reviewChanges' });

    assert.equal(commands.executed.some(({ command }) => command === 'vscode.changes' || command === 'vscode.diff'), false);
    assert.deepEqual(harness.sidebar.controller.snapshot().changes, state.changes);
    assert.equal(window.visibleEditors.length, 0);
  } finally {
    await close(harness);
  }
});
