import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('reviewFile rejects a path that escapes the workspace despite sharing its raw string prefix', async () => {
  resetVscode();
  const harness = openSidebar();
  const outsideFile = path.resolve(harness.workspacePath, '../outside-secret.txt');
  writeFileSync(outsideFile, 'synthetic secret file contents');
  const traversalPath = `${harness.workspacePath}/../outside-secret.txt`;
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: traversalPath, kind: 'update', previousText: 'before state' }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: traversalPath });

    assert.equal(commands.executed.some((entry) => entry.command === 'vscode.diff'), false);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'synthetic secret file contents');
    assert.equal(window.visibleEditors.length, 0);
    assert.equal(harness.sidebar.controller.snapshot().changes[0]?.previousText, 'before state');
  } finally {
    await close(harness);
  }
});
