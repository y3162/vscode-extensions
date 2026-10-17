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

test('plan resolution ignores missing and unknown decisions until an explicit choice arrives', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    const resolution = harness.sidebar.controller.interactions.requestPlan({ id: 'plan-approval', plan: 'Keep the sandbox', todos: [] });
    await settle();

    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval' });
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval', decision: 'approve' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan?.id, 'plan-approval');

    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval', decision: 'accepted' });
    assert.equal(await resolution, 'accepted');
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan, null);
  } finally {
    await close(harness);
  }
});

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

test('a rewind-journal directory error is reported while the sidebar remains usable', async () => {
  resetVscode();
  const harness = openSidebar(({ context }) => {
    const history = path.join(context.storageUri.fsPath, 'history', 'v1');
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, 'rewind-journals'), 'not a directory');
  });
  try {
    const view = createView();
    await ready(harness.sidebar, view);
    await settle();
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('ENOTDIR')));
    await harness.sidebar.handleMessage({ type: 'logs' });
    assert.equal(harness.output.shown, true);
    assert.ok(window.errorMessages.length === 0);
  } finally {
    await close(harness);
  }
});
