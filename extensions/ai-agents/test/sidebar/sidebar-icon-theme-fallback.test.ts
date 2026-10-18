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

test('icon theme with no matching definition keeps badge fallback after an invalid theme file', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'empty-icons' };
  const harness = openSidebar();
  const view = createView();
  const themeDir = path.join(harness.root, 'empty-theme');
  mkdirSync(themeDir, { recursive: true });
  const themeFile = Uri.file(path.join(themeDir, 'icons.json'));
  workspace.files.set(themeFile.fsPath, new TextEncoder().encode('{ invalid json'));
  extensions.all.push({
    extensionUri: Uri.file(themeDir),
    packageJSON: { contributes: { iconThemes: [{ id: 'unrelated', path: 'other.json' }, { id: 'empty-icons', path: 'icons.json' }] } },
  });
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'no-definition.abc', kind: 'update', previousText: 'old' }];
    state.messages = [{ id: 'empty-theme-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'no-definition.abc', kind: 'update', previousText: 'old' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    const last = view.messages.filter((message) => message.type === 'state').at(-1) as {
      messages: {
        upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: { type?: string; badge?: string } }> } }>;
      };
      shell: { changes: Array<{ icon?: { type?: string; badge?: string } }> };
    };
    const messageIcon = last.messages.upserts.find((message) => message.id === 'empty-theme-message')?.meta?.files?.[0]?.icon;
    const shellIcon = last.shell.changes[0]?.icon;
    assert.equal(messageIcon?.type, 'badge');
    assert.equal(messageIcon?.badge, 'ABC');
    assert.equal(shellIcon?.type, 'badge');
    assert.equal(shellIcon?.badge, 'ABC');
  } finally {
    await close(harness);
  }
});
