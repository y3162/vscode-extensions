import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, env, languages, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Japanese context routes attach only available content and label each supported context source', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'context file.ts');
  writeFileSync(file, 'const answer = 42;');
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    await harness.sidebar.insertContext('file');
    assert.equal(view.messages.some((message) => message.type === 'insert'), false, 'no active editor produces no file token');
    window.activeTextEditor = {
      document: { uri: Uri.file(file), getText: () => 'const answer = 42;', lineCount: 1, lineAt: () => ({ text: 'const answer = 42;' }) },
      selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
    await harness.sidebar.insertContext('file');
    let inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'ファイル');
    assert.equal(inserted?.text, '@"context file.ts" ');

    window.activeTextEditor = {
      document: { uri: Uri.file(file), getText: () => 'const answer = 42;', lineCount: 1, lineAt: () => ({ text: 'const answer = 42;' }) },
      selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 19 } },
    };
    await harness.sidebar.insertContext('selection');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, '選択範囲');
    assert.match(String(inserted?.text), /Context: selection context file\.ts:1-1/);

    languages.entries.push([Uri.file(file), [{ severity: 0, message: 'synthetic diagnostic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]]);
    await harness.sidebar.insertContext('problems');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, '問題');
    assert.match(String(inserted?.text), /synthetic diagnostic/);

    await harness.sidebar.insertContext('git');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'Git 差分');
    assert.match(String(inserted?.text), /git status:\n/);

    window.shellListeners[0]?.({ exitCode: 0, execution: { commandLine: 'echo round12-context' } });
    await harness.sidebar.insertContext('terminal');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'ターミナル');
    assert.match(String(inserted?.text), /echo round12-context \(exit 0\)/);
  } finally {
    await close(harness);
  }
});
