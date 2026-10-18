import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { commands, env, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('the apiKey webview route delegates to the selected provider command', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    await harness.sidebar.handleMessage({ type: 'apiKey' });
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'apiKey' });

    assert.deepEqual(commands.executed.map(({ command }) => command), [
      'ai-agents.setCodexApiKey', 'ai-agents.setCursorApiKey',
    ]);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});
