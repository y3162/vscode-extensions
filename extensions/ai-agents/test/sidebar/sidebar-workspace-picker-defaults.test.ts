import assert from 'node:assert/strict';

import { mkdirSync, rmSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { openSidebar, waitFor } from '../support/vscode-harness.js';

async function close(harness: ReturnType<typeof openSidebar>): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('newChat selects the first remaining workspace folder after the selected folder disappears', async () => {
  resetVscode();
  const harness = openSidebar();
  const remainingFolder = path.join(harness.root, 'remaining-workspace');
  mkdirSync(remainingFolder);
  try {
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, harness.workspacePath);
    workspace.workspaceFolders = [{ name: 'remaining', uri: Uri.file(remainingFolder), index: 0 }];

    await harness.sidebar.newChat();

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.selection.cwd, remainingFolder, 'the first valid folder becomes the new working directory');
    assert.equal(state.messages.length, 0, 'the reset conversation remains empty');
    assert.equal(harness.sidebar.controller.hasSession(), false, 'changing the working folder does not create a backend session');
  } finally {
    await close(harness);
  }
});
