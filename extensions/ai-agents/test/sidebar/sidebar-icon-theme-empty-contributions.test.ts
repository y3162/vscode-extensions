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

test('an empty extension list completes icon theme lookup and keeps per-file badge icons', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'round16-missing-theme' };
  const harness = openSidebar();
  const view = createView();
  try {
    assert.equal(extensions.all.length, 0);
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'unchanged-theme.ts', kind: 'update', previousText: 'before' }];
    state.messages = [{ id: 'round16-icon-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'unchanged-theme.ts', kind: 'update', previousText: 'before' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    const sent = view.messages.filter((message) => message.type === 'state').at(-1) as {
      messages: { upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: { type?: string; badge?: string } }> } }> };
      shell: { changes: Array<{ icon?: { type?: string; badge?: string } }> };
    };
    const messageIcon = sent.messages.upserts.find((message) => message.id === 'round16-icon-message')?.meta?.files?.[0]?.icon;
    assert.deepEqual(messageIcon, { type: 'badge', badge: 'TS' });
    assert.deepEqual(sent.shell.changes[0]?.icon, { type: 'badge', badge: 'TS' });
  } finally {
    await close(harness);
  }
});
