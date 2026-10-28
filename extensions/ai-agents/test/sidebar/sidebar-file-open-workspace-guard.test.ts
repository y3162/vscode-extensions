import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

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

test('a png opens in the image editor instead of failing as a text document', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'shot.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    await harness.sidebar.handleMessage({ type: 'openFile', path: file });
    assert.equal(window.visibleEditors.length, 0);
    const opened = commands.executed.at(-1);
    assert.equal(opened?.command, 'vscode.open');
    assert.equal((opened?.args[0] as { fsPath: string }).fsPath, file);
  } finally {
    await close(harness);
  }
});

test('a binary text-editor refusal falls back to vscode.open without a chat error', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'notes.txt');
  writeFileSync(file, 'text');
  const view = createView();
  const original = window.showTextDocument;
  window.showTextDocument = async () => {
    throw new Error('cannot open file:///notes.txt. Detail: File seems to be binary and cannot be opened as text');
  };
  try {
    await harness.sidebar.handleMessage({ type: 'openFile', path: file }, view as never);
    assert.equal(commands.executed.at(-1)?.command, 'vscode.open');
    assert.equal(view.messages.some((message) => message.type === 'error'), false);
  } finally {
    window.showTextDocument = original;
    await close(harness);
  }
});
