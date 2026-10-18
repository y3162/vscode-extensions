import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { resetVscode, env, window } from '../support/vscode-stub.js';

import { createView, openSidebar, settle, type Harness, type TestView } from '../support/vscode-harness.js';

async function ready(sidebar: Harness['sidebar'], view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('malformed webview messages are ignored and file review without a valid line does not move the editor selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'read-only.txt');
  writeFileSync(file, 'keep this file unchanged');
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage(42);
    await harness.sidebar.handleMessage({ type: 'copy', text: 42, requestId: 'bad-text' }, view as never);
    await harness.sidebar.handleMessage({ type: 'copy', text: 'text', requestId: 42 }, view as never);
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 42 });
    await harness.sidebar.handleMessage({ type: 'rewind', turnId: 42, editedText: 'replacement' });
    assert.equal(env.clipboard.text, '');
    assert.equal(harness.context.workspaceState.get('ai-agents.dismissedWarning'), undefined);
    assert.equal(view.messages.filter((message) => message.type === 'copyResult').length, 0);

    await harness.sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: '' });
    await harness.sidebar.handleMessage({ type: 'suggest', query: 5, requestId: 'bad-id' });
    const suggestions = view.messages.filter((message) => message.type === 'suggestions').at(-1);
    assert.deepEqual(suggestions?.items, []);
    assert.equal(suggestions?.requestId, 0);

    await harness.sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'openFile', path: file, line: 'not-a-line', column: -1 });
    assert.equal(window.visibleEditors.at(-1)?.document.uri.fsPath, file);
    assert.equal(window.visibleEditors.at(-1)?.selection, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'keep this file unchanged');
  } finally {
    await close(harness);
  }
});
