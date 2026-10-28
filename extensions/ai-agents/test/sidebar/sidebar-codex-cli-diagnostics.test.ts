import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Codex diagnostics report a synthetic successful CLI check and redact its output', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const executable = path.join(harness.root, 'synthetic-codex.cjs');
  writeFileSync(executable, "process.stdout.write('Codex fixture 0.1\\n');\nprocess.stderr.write('api_key=fixture-secret-value\\n');\n");
  workspace.configuration['ai-agents']!['codex.executablePath'] = executable;
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /OK Codex CLI \(override\)/);
    assert.match(report, /Codex fixture 0\.1/);
    assert.match(report, /api_key=\[redacted\]/);
    assert.doesNotMatch(report, /fixture-secret-value/);
    assert.match(report, /OK Backend\ncodex\/cli/);
  } finally {
    await close(harness);
  }
});
