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

test('diagnostics use bundled Codex fallback and tolerate an empty workspace; instructions skip local lookup', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const fakeCli = path.join(harness.root, 'fake-codex.cjs');
  writeFileSync(fakeCli, "process.stdout.write('Codex synthetic 1.0\\n');\n");
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    workspace.configuration['ai-agents']!['codex.executablePath'] = '';
    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const bundled = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(bundled, /Codex CLI \(bundled\)/, 'an empty executable setting selects the packaged Codex CLI');

    workspace.configuration['ai-agents']!['codex.executablePath'] = fakeCli;
    await harness.sidebar.controller.select({ provider: 'codex', cwd: '', model: '' });
    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const noWorkspace = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(noWorkspace, /Codex CLI \(override\)/);
    assert.match(noWorkspace, /Codex synthetic 1\.0/);

    await harness.sidebar.handleMessage({ type: 'instructions' });
    const instructions = view.messages.filter((message) => message.type === 'inspector').at(-1);
    assert.equal(instructions?.title, 'Rules / Skills / MCP');
    assert.equal(instructions?.text, '', 'without a workspace or session there are no local or live instruction sources');
  } finally {
    await close(harness);
  }
});
