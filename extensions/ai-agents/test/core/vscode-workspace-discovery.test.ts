import '../support/register-cursor-sdk.mjs';

import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test } from 'node:test';

import { instructionSummary, searchWorkspace, workspaceCommands } from '../../src/vscode-context.js';

import { commands, ExtensionContext, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test('workspace search applies exact, prefix, substring, and fallback ranking', async () => {
  resetVscode();
  const cwd = tempDir('ai-agents-search-rank-');
  try {
    workspace.findFilesResult = ['app.ts', 'apple.ts', 'mapple.ts', 'zebra.ts']
      .map((name) => Uri.file(path.join(cwd, 'src', name)));
    const results = await searchWorkspace(cwd, 'app');
    assert.deepEqual(results.slice(0, 3).map((item) => item.label), ['app.ts', 'apple.ts', 'mapple.ts']);
    assert.equal(results.find((item) => item.token === 'src')?.label, 'src');
    assert.ok(results.findIndex((item) => item.token === 'src') > 2);
    assert.ok(results.findIndex((item) => item.label === 'zebra.ts') > 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace command cache remains valid until the 30 second boundary, then refreshes', async (t) => {
  resetVscode();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const cwd = tempDir('ai-agents-command-cache-');
  const commandDir = path.join(cwd, '.cursor', 'commands');
  const file = path.join(commandDir, 'refresh.md');
  const name = `Refresh${path.basename(cwd).replace(/[^a-z0-9]/gi, '')}`;
  try {
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(file, `---\nname: ${name}\ndescription: first\n---\ninitial`);
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'first');
    writeFileSync(file, `---\nname: ${name}\ndescription: second\n---\nupdated`);
    now += 29_999;
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'first');
    now += 1;
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'second');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});;;
