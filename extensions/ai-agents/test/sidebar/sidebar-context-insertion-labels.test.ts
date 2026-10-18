import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('English Git context insertion labels and forwards the generated workspace summary', async () => {
  resetVscode();
  env.language = 'en-US';
  const harness = openSidebar();
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.insertContext('git');

    const inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'Git diff');
    assert.match(String(inserted?.text), /git status:/);
    assert.ok(commands.executed.some((entry) => entry.command === 'ai-agents.chat.focus'));
  } finally {
    await close(harness);
  }
});
