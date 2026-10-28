import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('diagnostics omit an empty workspace cwd and let Cursor CLI resolve from its process cwd', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const cli = path.join(harness.root, 'cursor-cwd-diagnostics.cjs');
  writeFileSync(cli, "process.stdout.write(process.cwd() + '\\n');\n");
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: '' });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /OK Cursor CLI \(override\)/);
    assert.ok(report.split(process.cwd()).length - 1 >= 2, 'both version and status run without a workspace cwd');
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, '');
  } finally {
    await close(harness);
  }
});
