import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('relative openFile is refused when the selected conversation has no workspace cwd', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'relative-without-cwd.txt');
  writeFileSync(file, 'keep user data');
  try {
    const state = harness.sidebar.controller.snapshot();
    state.selection = { ...state.selection, cwd: '' };
    harness.sidebar.controller.restoreSnapshot(state);

    await assert.rejects(harness.sidebar.handleMessage({ type: 'openFile', path: 'relative-without-cwd.txt' }), /ワークスペース外/);

    assert.equal(window.visibleEditors.length, 0, 'a relative path is not guessed from the first workspace folder');
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8')), 'keep user data');
  } finally {
    await close(harness);
  }
});
