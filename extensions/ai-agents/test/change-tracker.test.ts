import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureGitBaselines } from '../src/change-tracker.js';
import { revertChange } from '../src/change-review.js';

test('Git baselines preserve dirty, untracked, renamed and unusual paths without trusting ignored files', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-baseline-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init', '-q');
    const names = ['日本語.txt', ' name with spaces ', 'quote"line\n.txt', 'renamed.txt', 'clean.txt'];
    for (const name of names) await writeFile(path.join(cwd, name), 'head\n');
    await writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
    for (const name of names.slice(0, 3)) await writeFile(path.join(cwd, name), 'user edit\n');
    await rename(path.join(cwd, 'renamed.txt'), path.join(cwd, 'new name.txt'));
    git('add', '-A');
    await writeFile(path.join(cwd, 'untracked.txt'), 'user untracked\n');
    await writeFile(path.join(cwd, 'ignored.txt'), 'user ignored\n');
    const baselines = await captureGitBaselines(cwd);
    assert.ok(baselines);
    for (const name of [...names.slice(0, 3), 'new name.txt']) {
      const expected = await readFile(path.join(cwd, name), 'utf8');
      await writeFile(path.join(cwd, name), 'agent edit\n');
      assert.equal(await baselines.lookup(name), expected);
      await revertChange({ path: path.join(cwd, name), kind: 'update', previousText: await baselines.lookup(name) }, [cwd]);
      assert.equal(await readFile(path.join(cwd, name), 'utf8'), expected);
    }
    assert.equal(await baselines.lookup('untracked.txt'), 'user untracked\n');
    assert.equal(await baselines.lookup('ignored.txt'), undefined);
    assert.equal(await baselines.lookup('../outside.txt'), undefined);
    await writeFile(path.join(cwd, 'clean.txt'), 'new commit\n');
    git('add', 'clean.txt'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'later');
    assert.equal(await baselines.lookup('clean.txt'), 'head\n', 'use the revision captured before the turn');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('shell changes exclude pre-existing edits and retain a content-preserving Git rename', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-net-changes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init', '-q');
    await writeFile(path.join(cwd, 'note.txt'), 'head\n');
    await writeFile(path.join(cwd, 'old.txt'), 'same\n');
    await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
    await writeFile(path.join(cwd, 'note.txt'), 'user\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'user\n');
    const baselines = (await captureGitBaselines(cwd))!;
    assert.deepEqual(await baselines.changes(), []);
    assert.equal(await baselines.lookup('binary.dat'), undefined);
    await writeFile(path.join(cwd, 'note.txt'), 'agent\n');
    git('mv', 'old.txt', 'new.txt');
    const changes = await baselines.changes();
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.find((change) => change.path === 'note.txt'), {
      path: 'note.txt', kind: 'update', previousText: 'user\n', previousMode: 0o644, mode: 0o644,
      preview: [{ kind: 'remove', line: 1, text: 'user' }, { kind: 'add', line: 1, text: 'agent' }], additions: 1, deletions: 1,
    });
    assert.deepEqual(changes.find((change) => change.path === 'new.txt'), { path: 'new.txt', kind: 'rename', oldPath: 'old.txt', previousText: 'same\n', previousMode: 0o644, mode: 0o644, additions: 0, deletions: 0 });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
