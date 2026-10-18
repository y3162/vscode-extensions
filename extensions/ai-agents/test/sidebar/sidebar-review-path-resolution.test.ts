import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('an absolute review path remains resolvable under an opened workspace when selection cwd is empty', async () => {
  resetVscode();
  const harness = openSidebar();
  const currentFile = path.join(harness.workspacePath, 'absolute-review.txt');
  writeFileSync(currentFile, 'current workspace content');
  try {
    const state = harness.sidebar.controller.snapshot();
    state.selection = { ...state.selection, cwd: '' };
    state.changes = [{ path: currentFile, kind: 'update', previousText: 'saved baseline' }];
    harness.sidebar.controller.restoreSnapshot(state);

    await harness.sidebar.handleMessage({ type: 'openDiff', path: currentFile });

    const diff = commands.executed.find((entry) => entry.command === 'vscode.diff');
    assert.ok(diff, 'an absolute path under the workspace does not require a selected cwd');
    const baseline = diff.args[0] as Uri;
    assert.equal(readFileSync(baseline.fsPath, 'utf8'), 'saved baseline');
    assert.equal(readFileSync(currentFile, 'utf8'), 'current workspace content', 'opening review never edits the user file');
    assert.equal((diff.args[1] as Uri).fsPath, currentFile);
  } finally {
    await close(harness);
  }
});
