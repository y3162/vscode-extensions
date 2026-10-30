import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { contentDigest } from '../../src/review-acceptance.js';
import type { StateMessage } from '../../src/protocol.js';
import { resetVscode, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, waitFor, type Harness, type TestView } from '../support/vscode-harness.js';

function states(view: TestView): StateMessage[] {
  return view.messages.filter((message) => message.type === 'state') as unknown as StateMessage[];
}

async function ready(sidebar: Harness['sidebar'], view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Keep All leaves file bytes in place and Undo All requires confirmation before restoring them', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'kept.txt');
  writeFileSync(file, 'after\n');
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.messages = [{ id: 'user', role: 'user', text: 'edit', at: 1 }];
    state.changes = [{ path: file, kind: 'update', previousText: 'before\n', observedDigest: contentDigest('after\n') }];
    harness.sidebar.controller.restoreSnapshot(state);
    await waitFor(() => states(view).some((item) => item.shell.review?.undoEnabled === true), 'undo enabled');
    assert.match(states(view).at(-1)?.shell.review?.status ?? '', /pending/);

    await harness.sidebar.handleMessage({ type: 'keepAllChanges' });
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    await waitFor(() => states(view).at(-1)?.shell.review?.status === 'accepted', 'accepted');
    assert.equal(states(view).at(-1)?.shell.review?.undoEnabled, false);
    assert.equal(states(view).at(-1)?.shell.review?.keepEnabled, false);
    assert.equal(states(view).at(-1)?.shell.changes.length, 1);

    const saved = harness.sidebar.controller.snapshot();
    const other = harness.sidebar.controller.snapshot();
    other.reviewAcceptance = undefined;
    other.changes = [{ path: path.join(harness.workspacePath, 'other.txt'), kind: 'update', previousText: 'x', observedDigest: contentDigest('y') }];
    harness.sidebar.controller.restoreSnapshot(other);
    await waitFor(() => states(view).at(-1)?.shell.review?.status === 'pending', 'other session pending');
    harness.sidebar.controller.restoreSnapshot(saved);
    await waitFor(() => states(view).at(-1)?.shell.review?.status === 'accepted', 'reloaded acceptance');

    window.warningQueue.push({ value: undefined });
    await harness.sidebar.handleMessage({ type: 'undoAllChanges' });
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    assert.equal(harness.sidebar.controller.snapshot().changes.length, 1);
    assert.match(window.warningMessages.at(-1) ?? '', /kept\.txt/);

    window.warningQueue.push({ value: 'Undo All' });
    await harness.sidebar.handleMessage({ type: 'undoAllChanges' });
    assert.equal(readFileSync(file, 'utf8'), 'before\n');
    assert.equal(harness.sidebar.controller.snapshot().changes.length, 0);
    await waitFor(() => states(view).at(-1)?.shell.changes.length === 0, 'review bar source cleared');
  } finally {
    await close(harness);
  }
});

test('Undo All refuses a file the user edited after the agent and does not report that as success', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'edited.txt');
  writeFileSync(file, 'user edit\n');
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.messages = [{ id: 'user', role: 'user', text: 'edit', at: 1 }];
    state.changes = [{ path: file, kind: 'update', previousText: 'before\n', observedDigest: contentDigest('after\n') }];
    harness.sidebar.controller.restoreSnapshot(state);
    await waitFor(() => states(view).some((item) => item.shell.review?.undoEnabled === false && Boolean(item.shell.review?.undoReason)), 'undo blocked');
    window.warningQueue.push({ value: 'Undo All' });
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'undoAllChanges' }), /一致しない/);
    assert.equal(readFileSync(file, 'utf8'), 'user edit\n');
    assert.equal(window.warningMessages.some((message) => message.includes('edited.txt')), false);

    writeFileSync(file, 'after\n');
    workspace.textDocuments.push({ isDirty: true, uri: { fsPath: file } });
    harness.sidebar.controller.restoreSnapshot(harness.sidebar.controller.snapshot());
    await waitFor(() => /未保存/.test(states(view).at(-1)?.shell.review?.undoReason ?? ''), 'dirty blocks undo');
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'undoAllChanges' }), /未保存/);
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
  } finally {
    workspace.textDocuments.length = 0;
    await close(harness);
  }
});

test('concurrent Undo All requests restore two files once after one confirmation', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const first = path.join(harness.workspacePath, 'first.txt');
  const second = path.join(harness.workspacePath, 'second.txt');
  writeFileSync(first, 'after one');
  writeFileSync(second, 'after two');
  try {
    await ready(harness.sidebar, view);
    const state = harness.sidebar.controller.snapshot();
    state.changes = [
      { path: first, kind: 'update', previousText: 'before one', observedDigest: contentDigest('after one') },
      { path: second, kind: 'update', previousText: 'before two', observedDigest: contentDigest('after two') },
    ];
    harness.sidebar.controller.restoreSnapshot(state);
    window.warningQueue.push({ value: 'Undo All' });
    await Promise.all([
      harness.sidebar.handleMessage({ type: 'undoAllChanges' }),
      harness.sidebar.handleMessage({ type: 'undoAllChanges' }),
    ]);
    assert.equal(window.warningMessages.length, 1);
    assert.equal(readFileSync(first, 'utf8'), 'before one');
    assert.equal(readFileSync(second, 'utf8'), 'before two');
    assert.equal(harness.sidebar.controller.snapshot().changes.length, 0);
  } finally {
    await close(harness);
  }
});
