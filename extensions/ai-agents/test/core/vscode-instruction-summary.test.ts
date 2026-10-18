import '../support/register-cursor-sdk.mjs';

import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test } from 'node:test';

import { instructionSummary, searchWorkspace, workspaceCommands } from '../../src/vscode-context.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('instruction summary handles absent local rules and files', async () => {
  const cwd = tempDir('ai-agents-instructions-missing-');
  try {
    writeFileSync(path.join(cwd, 'AGENTS.md'), '# local rules');
    const summary = await instructionSummary(cwd);
    assert.match(summary, /AGENTS\.md/);
    assert.doesNotMatch(summary, /CLAUDE\.md|\.cursorrules|\.cursor\/rules:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});;
