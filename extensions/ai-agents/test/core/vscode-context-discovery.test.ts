import assert from 'node:assert/strict';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { instructionSummary, searchWorkspace } from '../../src/vscode-context.js';

test('workspace search ranks exact and non-exact filenames from synthetic workspace entries', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rank-'));
  try {
    await writeFile(path.join(cwd, 'needles'), 'prefix');
    await writeFile(path.join(cwd, 'needle-more'), 'contains');
    await writeFile(path.join(cwd, 'needle'), 'exact');
    const { Uri, workspace } = await import('../support/vscode-stub.js');
    workspace.findFilesResult = ['needle-more', 'needles', 'needle'].map((name) => Uri.file(path.join(cwd, name)));
    const matches = await searchWorkspace(cwd, 'needle');
    assert.equal(matches[0]?.token, 'needle', 'the exact token sorts before prefix and substring candidates');
    assert.deepEqual(new Set(matches.map((item) => item.token)), new Set(['needle', 'needles', 'needle-more']));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('instruction summary uses an injected empty home and reports the empty-state text deterministically', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-empty-workspace-'));
  const userHome = await mkdtemp(path.join(tmpdir(), 'ai-agents-empty-home-'));
  try {
    assert.equal(await instructionSummary(cwd, userHome), 'No AGENTS.md, rules, skills, or MCP config found.');
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(userHome, { recursive: true, force: true }),
    ]);
  }
});;;
