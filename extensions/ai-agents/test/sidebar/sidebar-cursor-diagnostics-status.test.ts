import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor diagnostic failures retain separate version and status results without affecting the session state', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const cli = path.join(harness.root, 'cursor-failing-diagnostics.cjs');
  writeFileSync(cli, [
    "if (process.argv[2] === '--version') { process.stderr.write('synthetic version failure'); process.exitCode = 17; }",
    "else { process.stderr.write('synthetic status failure'); process.exitCode = 18; }",
  ].join('\n'));
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const original = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(original);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-out' }) });

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /FAIL Cursor CLI \(override\)/);
    assert.match(report, /synthetic version failure/);
    assert.match(report, /FAIL .*cursor-failing-diagnostics\.cjs status/);
    assert.match(report, /synthetic status failure/);
    assert.match(report, /FAIL Cursor SDK auth\nlogged-out/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    Object.defineProperty(auth, 'status', original);
    await close(harness);
  }
});
