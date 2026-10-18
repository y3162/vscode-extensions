import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test } from 'node:test';

import { commands, resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('login ignores a stale conversation action and still signs in from the current front route', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  workspace.configuration['ai-agents']!['codex.executablePath'] = path.resolve(process.cwd(), 'test/fixtures/mock-codex.cjs');
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'WAIT_FOR_STOP' });
    await waitFor(() => view.messages.some((message) => message.type === 'state' && (message.shell as { conversationId?: string } | undefined)?.conversationId === 'front'), 'initial conversation identity');

    await harness.sidebar.handleMessage({ type: 'newChat' });
    await harness.sidebar.handleMessage({ type: 'login', conversationId: 'front' });
    assert.equal(window.terminals.length, 0, 'a login click from an older conversation cannot affect the new front');
    assert.equal(commands.executed.some((entry) => entry.command === 'ai-agents.cursorLogin'), false);

    await harness.sidebar.handleMessage({ type: 'login' });
    assert.equal(window.terminals.length, 1);
    assert.equal(window.terminals[0]?.name, 'Codex Login');
    assert.deepEqual(window.terminals[0]?.sent, ['codex login']);
    assert.equal(window.terminals[0]?.shown, 1);
  } finally {
    await close(harness);
  }
});
