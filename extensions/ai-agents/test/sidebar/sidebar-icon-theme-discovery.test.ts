import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('icon theme discovery skips malformed contributions and renders a font icon without a font asset', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'late-icons' };
  const harness = openSidebar();
  const view = createView();
  const themeDir = path.join(harness.root, 'icon-theme');
  mkdirSync(themeDir, { recursive: true });
  const themeFile = Uri.file(path.join(themeDir, 'icons.json'));
  workspace.files.set(themeFile.fsPath, new TextEncoder().encode(JSON.stringify({
    fileExtensions: { zz: 'glyph' },
    iconDefinitions: { glyph: { fontCharacter: 'Z', fontId: 'fixture-font' } },
    fonts: [{ id: 'fixture-font', src: [] }],
  })));
  extensions.all.push(
    { extensionUri: Uri.file(path.join(harness.root, 'no-contributions')), packageJSON: {} },
    { extensionUri: Uri.file(path.join(harness.root, 'no-path')), packageJSON: { contributes: { iconThemes: [{ id: 'other', path: 'ignored.json' }, { id: 'late-icons' }] } } },
    { extensionUri: Uri.file(themeDir), packageJSON: { contributes: { iconThemes: [{ id: 'late-icons', path: 'icons.json' }] } } },
  );
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'sample.zz', kind: 'update', previousText: 'old' }];
    state.messages = [{ id: 'theme-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'sample.zz', kind: 'update', previousText: 'old' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await waitFor(() => {
      const message = view.messages.filter((item) => item.type === 'state').at(-1) as { messages?: { upserts?: Array<{ meta?: { files?: Array<{ icon?: { type?: string } }> } }> } } | undefined;
      return message?.messages?.upserts?.some((item) => item.meta?.files?.[0]?.icon?.type === 'font') === true;
    }, 'font themed file icon');

    const stateMessage = view.messages.filter((item) => item.type === 'state').at(-1) as {
      messages: { upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: Record<string, unknown> }> } }> };
      shell: { changes: Array<{ name: string; icon?: Record<string, unknown> }> };
    };
    const icon = stateMessage.messages.upserts.find((item) => item.id === 'theme-message')?.meta?.files?.[0]?.icon;
    assert.equal(icon?.type, 'font');
    assert.equal(icon?.fontCharacter, 'Z');
    assert.equal(icon?.badge, 'ZZ');
    assert.equal('src' in (icon ?? {}), false, 'font definitions without a source path render without a font asset URL');
    assert.equal('fontColor' in (icon ?? {}), false, 'missing font color stays omitted');
    assert.equal(stateMessage.shell.changes.find((change) => change.name === 'sample.zz')?.icon?.type, 'font');
  } finally {
    await close(harness);
  }
});
