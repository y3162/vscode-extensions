import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

import { test } from 'node:test';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('review routes build multi-file entries and open file URLs with a bounded selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'review.txt');
  const originalParse = Uri.parse;
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [
      { path: 'review.txt', kind: 'delete', previousText: null },
      { path: file, kind: 'update', previousText: 'before' },
      { path: 'turn.diff', kind: 'update', previousText: 'synthetic patch', diff: '+not a workspace file' },
      { path: '../outside.txt', kind: 'update', previousText: 'unsafe' },
    ];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'reviewChanges' });

    const review = commands.executed.find((entry) => entry.command === 'vscode.changes');
    assert.ok(review, 'the multi-file review command is invoked for recoverable workspace changes');
    const entries = review.args[1] as Array<[Uri, Uri | undefined, Uri | undefined]>;
    assert.equal(entries.length, 2, 'synthetic and out-of-workspace paths are omitted');
    assert.equal(entries[0]?.[0].fsPath, file);
    assert.equal(entries[0]?.[2], undefined, 'deleted files have no current side in the diff');
    assert.equal(entries[1]?.[2]?.fsPath, file);

    Object.defineProperty(Uri, 'parse', {
      configurable: true,
      value: (value: string) => Uri.file(fileURLToPath(value)),
    });
    await harness.sidebar.handleMessage({
      type: 'openFile', path: pathToFileURL(file).toString(), line: '2', column: '0', endLine: '99',
    });
    const editor = window.visibleEditors.at(-1)!;
    assert.equal(editor.document.uri.fsPath, file);
    assert.equal(editor.selection?.start.line, 1);
    assert.equal(editor.selection?.start.character, 0);
    assert.equal(editor.selection?.end.line, 3, 'selection end is clamped to the document line count');
    assert.equal(editor.selection?.end.character, 6);
    assert.equal(editor.revealed.at(-1)?.end.line, editor.selection?.end.line);
    assert.equal(editor.revealed.at(-1)?.end.character, editor.selection?.end.character);
  } finally {
    Object.defineProperty(Uri, 'parse', { configurable: true, value: originalParse });
    await close(harness);
  }
});
