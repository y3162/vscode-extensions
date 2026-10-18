import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('openDiff writes a null baseline as an empty file and refuses relative review without a workspace', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'before-null.txt', kind: 'update', previousText: null }];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'openDiff', path: 'before-null.txt' });

    const diff = commands.executed.find((entry) => entry.command === 'vscode.diff');
    assert.ok(diff);
    const baseline = diff.args[0] as Uri;
    assert.equal(readFileSync(baseline.fsPath, 'utf8'), '', 'a null saved baseline is represented as an empty file');
    assert.equal((diff.args[1] as Uri).fsPath, path.join(harness.workspacePath, 'before-null.txt'));

    await harness.sidebar.controller.select({ provider: 'codex', cwd: '', model: '' });
    commands.executed.length = 0;
    await harness.sidebar.handleMessage({ type: 'openDiff', path: 'before-null.txt' });
    assert.equal(commands.executed.some((entry) => entry.command === 'vscode.diff'), false,
      'a relative change cannot be resolved when the selected conversation has no workspace');
  } finally {
    await close(harness);
  }
});
