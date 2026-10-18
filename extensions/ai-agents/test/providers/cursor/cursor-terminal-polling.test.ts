import assert from 'node:assert/strict';

import fs, { type Dirent } from 'node:fs';

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test } from 'node:test';

import { CursorTerminals } from '../../../src/providers/cursor-terminals.js';

function log(status = 'running'): string {
  return `---\npid: 12345\ncommand: "sleep 60"\nstatus: ${status}\nstarted_at: 2026-10-17T00:48:02.596Z\n---\nready\n`;
}

function dirent(name: string, file: boolean, directory: boolean): Dirent {
  return { name, isFile: () => file, isDirectory: () => directory } as unknown as Dirent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('terminal polling reschedules after a run while a claimed shell remains running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-schedule-'));
  const folder = path.join(root, 'projects', 'workspace', 'terminals');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '123.txt'), log());
  let reads = 0;
  const readDirectory = async (directory: string, options: { withFileTypes: true }) => {
    reads += 1;
    return readdir(directory, options);
  };
  const monitor = new CursorTerminals(root, () => {}, async () => true, undefined, undefined, undefined, readDirectory);
  try {
    monitor.start();
    await monitor.finishRun(); // A running SDK process keeps polling even though the turn is over.
    const afterFinish = reads;
    await delay(150);
    const afterFirstScheduledRead = reads;
    assert.ok(afterFirstScheduledRead > afterFinish, 'the pending poll refreshes terminal records');
    await delay(150);
    assert.ok(reads > afterFirstScheduledRead, 'a still-running claimed shell schedules another refresh');
  } finally {
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal polling reschedules across two intervals while a run remains active', async () => {
  let reads = 0;
  const monitor = new CursorTerminals('/unused', () => {}, async () => true, undefined, undefined, undefined, async () => {
    reads += 1;
    return [];
  });
  try {
    monitor.start();
    const beforePolling = reads;
    await delay(150);
    const afterFirstInterval = reads;
    await delay(150);
    const afterSecondInterval = reads;
    assert.ok(afterFirstInterval > beforePolling, 'active run performs the first scheduled refresh');
    assert.ok(afterSecondInterval > afterFirstInterval, 'active run schedules another refresh without running terminal records');
  } finally {
    monitor.dispose();
  }
});

test('terminal polling stops after the pending refresh when inactive with no running records', async () => {
  let reads = 0;
  const monitor = new CursorTerminals('/unused', () => {}, async () => true, undefined, undefined, undefined, async () => {
    reads += 1;
    return [];
  });
  try {
    monitor.start();
    await delay(150);
    await monitor.finishRun();
    const afterFinish = reads;
    await delay(150);
    const afterPendingRefresh = reads;
    await delay(150);
    const afterWouldBeReschedule = reads;
    assert.ok(afterPendingRefresh > afterFinish, 'the already scheduled refresh runs after the turn finishes');
    assert.equal(afterWouldBeReschedule, afterPendingRefresh, 'inactive monitor with no running records does not schedule a third refresh');
  } finally {
    monitor.dispose();
  }
});

test('terminal scan ignores non-files and malformed names before opening log paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-filenames-'));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, 'workspace', 'terminals');
  await mkdir(folder, { recursive: true });
  const readDirectory = async (directory: string, _options: { withFileTypes: true }): Promise<Dirent[]> => {
    if (directory === projects) return [dirent('workspace', false, true)];
    if (directory === folder) return [
      dirent('9.txt', false, false),
      dirent('notes.txt', true, false),
      dirent('10.TXT', true, false),
      dirent('12.txt.bak', true, false),
    ];
    throw new Error(`unexpected directory: ${directory}`);
  };
  const updates: unknown[] = [];
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => true, undefined, undefined, undefined, readDirectory);
  try {
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(updates.some((update) => (update as { tool?: unknown }).tool !== undefined), false);
    assert.deepEqual((updates.at(-1) as { meta?: { terminals?: unknown[] } })?.meta?.terminals, []);
  } finally {
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
