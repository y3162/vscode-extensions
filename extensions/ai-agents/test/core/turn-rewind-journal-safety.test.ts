import assert from 'node:assert/strict';

import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';

import { readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { readTurnRewindJournal, restoreTurnRewindFiles, type RewindJournalFile, type TurnRewindJournal } from '../../src/turn-rewind.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test('malformed rewind journal entries are rejected without touching workspace files', async () => {
  const cwd = await temporaryDirectory('ai-agents-journal-entry-shape-');
  const workspaceFile = path.join(cwd, 'user.txt');
  const journalFile = path.join(cwd, 'journal.json');
  const sentinel = 'keep this file unchanged\n';
  await writeFile(workspaceFile, sentinel, { mode: 0o640 });
  const malformed = {
    version: 1,
    conversationId: 'conversation',
    branchId: 'branch',
    cwd,
    files: [{ path: 'user.txt', tempPath: '.ai-agents-rewind-00000000-0000-4000-8000-000000000005.tmp', beforeText: 17, beforeMode: 0o640, expectedText: 'after', expectedMode: 0o640, backupText: sentinel, backupMode: 0o640 }],
  };

  try {
    await writeFile(journalFile, JSON.stringify(malformed));
    await assert.rejects(readTurnRewindJournal(journalFile), /Invalid turn rewind journal/);
    assert.equal(await readFile(workspaceFile, 'utf8'), sentinel);
    assert.equal((await lstat(workspaceFile)).mode & 0o777, 0o640);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rewind rollback preserves an external edit made while restoration is in progress', async () => {
  const cwd = await temporaryDirectory('ai-agents-rewind-concurrent-edit-');
  const firstPath = path.join(cwd, 'a.txt');
  let conflictRelative = 'conflict';
  for (let index = 0; index < 35; index += 1) conflictRelative = path.join(conflictRelative, `dir${index.toString().padStart(2, '0')}xxxxxxx`);
  conflictRelative = path.join(conflictRelative, 'b.txt');
  const conflictPath = path.join(cwd, conflictRelative);
  const firstTemp = '.ai-agents-rewind-00000000-0000-4000-8000-000000000006.tmp';
  const secondTemp = '.ai-agents-rewind-00000000-0000-4000-8000-000000000007.tmp';
  await writeFile(firstPath, 'after-a\n', { mode: 0o644 });
  await mkdir(path.dirname(conflictPath), { recursive: true });
  const conflictingContents = 'x'.repeat(450_000);
  await writeFile(conflictPath, conflictingContents, { mode: 0o644 });
  let externalEditPreserved = false;
  const poll = setInterval(() => {
    if (externalEditPreserved) return;
    try {
      if (readFileSync(firstPath, 'utf8') !== 'before-a\n') return;
      writeFileSync(firstPath, 'concurrent user edit\n');
      externalEditPreserved = true;
      clearInterval(poll);
    } catch { /* The first file may not exist during the atomic replacement. */ }
  }, 1);

  const file = (relative: string, tempPath: string, beforeText: string, expectedText: string): RewindJournalFile => ({
    path: relative,
    tempPath,
    beforeText,
    beforeMode: 0o644,
    expectedText,
    expectedMode: 0o644,
    backupText: expectedText,
    backupMode: 0o644,
  });
  const journal: TurnRewindJournal = {
    version: 1,
    conversationId: 'conversation',
    branchId: 'branch',
    cwd,
    files: [file('a.txt', firstTemp, 'before-a\n', 'after-a\n'), file(conflictRelative, path.join(path.dirname(conflictRelative), secondTemp), 'before-b\n', 'after-b\n')],
  };

  try {
    await assert.rejects(restoreTurnRewindFiles(journal), /rollback was incomplete/);
    assert.equal(externalEditPreserved, true, 'the watcher should inject an edit after the first file is restored');
    assert.equal(await readFile(firstPath, 'utf8'), 'concurrent user edit\n');
    assert.equal((await readFile(conflictPath, 'utf8')).length, conflictingContents.length);
  } finally {
    clearInterval(poll);
    await rm(cwd, { recursive: true, force: true });
  }
});
