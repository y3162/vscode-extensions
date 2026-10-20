import { createGitFixture, renameGitFixture, snapshotGitFixture } from '../support/git-fixture.js';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureGitBaselines } from '../../src/change-tracker.js';
import { revertChange } from '../../src/change-review.js';

test('Git baselines preserve dirty, untracked, renamed and unusual paths without trusting ignored files', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-baseline-'));
  try {
    createGitFixture(cwd);
    const names = ['日本語.txt', ' name with spaces ', 'quote"line\n.txt', 'renamed.txt', 'clean.txt'];
    for (const name of names) await writeFile(path.join(cwd, name), 'head\n');
    await writeFile(path.join(cwd, '.gitignore'), 'ignored.txt\n');
    snapshotGitFixture(cwd);
    for (const name of names.slice(0, 3)) await writeFile(path.join(cwd, name), 'user edit\n');
    await rename(path.join(cwd, 'renamed.txt'), path.join(cwd, 'new name.txt'));
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
    snapshotGitFixture(cwd);
    assert.equal(await baselines.lookup('clean.txt'), 'head\n', 'use the revision captured before the turn');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('shell changes exclude pre-existing edits and retain a content-preserving Git rename', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-net-changes-'));
  try {
    createGitFixture(cwd);
    await writeFile(path.join(cwd, 'note.txt'), 'head\n');
    await writeFile(path.join(cwd, 'old.txt'), 'same\n');
    await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
    await Promise.all(['note.txt', 'old.txt', 'binary.dat'].map((name) => chmod(path.join(cwd, name), 0o644)));
    snapshotGitFixture(cwd);
    await writeFile(path.join(cwd, 'note.txt'), 'user\n');
    await writeFile(path.join(cwd, 'untracked.txt'), 'user\n');
    const baselines = (await captureGitBaselines(cwd))!;
    assert.deepEqual(await baselines.changes(), []);
    assert.equal(await baselines.lookup('binary.dat'), undefined);
    await writeFile(path.join(cwd, 'note.txt'), 'agent\n');
    renameGitFixture(cwd, 'old.txt', 'new.txt');
    const changes = await baselines.changes();
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.find((change) => change.path === 'note.txt'), {
      path: 'note.txt', kind: 'update', previousText: 'user\n', previousMode: 0o644, mode: 0o644,
      preview: [{ kind: 'remove', line: 1, text: 'user' }, { kind: 'add', line: 1, text: 'agent' }], additions: 1, deletions: 1,
    });
    assert.deepEqual(changes.find((change) => change.path === 'new.txt'), { path: 'new.txt', kind: 'rename', oldPath: 'old.txt', previousText: 'same\n', previousMode: 0o644, mode: 0o644, additions: 0, deletions: 0 });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an unborn repository keeps new files reviewable and a non-repository has no Git baseline', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-unborn-baseline-'));
  const plain = await mkdtemp(path.join(tmpdir(), 'ai-agents-no-git-baseline-'));
  try {
    createGitFixture(cwd);
    const baselines = await captureGitBaselines(cwd);
    assert.ok(baselines);
    assert.equal(await baselines.lookup('added-later.txt'), undefined);
    assert.equal(await baselines.lookupMode('added-later.txt'), undefined);

    await writeFile(path.join(cwd, 'added-later.txt'), 'new file\n');
    await chmod(path.join(cwd, 'added-later.txt'), 0o644);
    assert.deepEqual(await baselines.changes(), [{
      path: 'added-later.txt', kind: 'add', previousText: null, previousMode: null,
      mode: 0o644, preview: [{ kind: 'add', line: 1, text: 'new file' }], additions: 1, deletions: 0,
    }]);
    assert.equal(await captureGitBaselines(plain), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('binary baselines stay non-restorable and a new binary is listed without fabricated text metadata', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-binary-baseline-'));
  try {
    createGitFixture(cwd);
    await writeFile(path.join(cwd, 'tracked.bin'), Buffer.from([0x00, 0x01]));
    snapshotGitFixture(cwd);
    const baselines = await captureGitBaselines(cwd);
    assert.ok(baselines);

    await writeFile(path.join(cwd, 'tracked.bin'), 'replacement text');
    await writeFile(path.join(cwd, 'new.bin'), Buffer.from([0x02, 0x00, 0x03]));
    await chmod(path.join(cwd, 'new.bin'), 0o644);
    const changes = await baselines.changes();
    assert.deepEqual(changes, [{ path: 'new.bin', kind: 'add', previousText: null, previousMode: null, mode: 0o644 }]);
    assert.equal(await baselines.lookup('tracked.bin'), undefined);
    assert.equal(await readFile(path.join(cwd, 'tracked.bin'), 'utf8'), 'replacement text');
    assert.deepEqual(await readFile(path.join(cwd, 'new.bin')), Buffer.from([0x02, 0x00, 0x03]));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Git failures and paths replaced by directories stay non-restorable without throwing away safe history', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-baseline-protocol-'));
  try {
    let unavailableCalls = 0;
    assert.equal(await captureGitBaselines(cwd, async () => { unavailableCalls += 1; return undefined; }), undefined);
    assert.equal(unavailableCalls, 1, 'a failed initial status check does not proceed to other Git commands');

    await mkdir(path.join(cwd, 'tracked.txt'));
    await writeFile(path.join(cwd, 'tracked.txt', 'child.txt'), 'directory replacement');
    let statusCalls = 0;
    const baselines = await captureGitBaselines(cwd, async (_root, args) => {
      if (args[0] === 'status') return ++statusCalls === 1 ? ' D tracked.txt\0' : undefined;
      if (args[0] === 'rev-parse') return undefined;
      assert.fail(`unexpected Git command: ${args.join(' ')}`);
    });
    assert.ok(baselines);
    assert.equal(await baselines.lookup('tracked.txt'), undefined);
    assert.equal(await baselines.lookupMode('tracked.txt'), undefined, 'directory metadata is never used as a file baseline');
    assert.equal(await baselines.lookupMode('../outside.txt'), undefined, 'mode lookup refuses paths outside the workspace');
    assert.deepEqual(await baselines.changes(), [], 'a failed refresh cannot fabricate a workspace diff');

    const missingTree = await captureGitBaselines(cwd, async (_root, args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return 'deadbeef\n';
      if (args[0] === 'ls-tree') return undefined;
      assert.fail(`unexpected Git command: ${args.join(' ')}`);
    });
    assert.ok(missingTree);
    assert.equal(await missingTree.lookupMode('untracked-by-revision.txt'), undefined, 'a missing tree row has no safe file mode');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a workspace mode read failure is not confused with a missing baseline file', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-mode-read-error-'));
  const file = path.join(cwd, 'note.txt');
  await writeFile(file, 'user version\n');
  let fileChecks = 0;
  const files = {
    lstat: async (candidate: string) => {
      if (candidate === file && [2, 4].includes(++fileChecks)) throw Object.assign(new Error('mode denied'), { code: 'EACCES' });
      return lstat(candidate);
    },
    readFile,
  };
  let statusCalls = 0;

  try {
    const baselines = await captureGitBaselines(cwd, async (_root, args) => {
      if (args[0] === 'status') return ++statusCalls <= 2 ? '?? note.txt\0' : undefined;
      if (args[0] === 'rev-parse') return undefined;
      assert.fail(`unexpected Git command: ${args.join(' ')}`);
    }, files);
    assert.ok(baselines);
    assert.equal(await baselines.lookup('note.txt'), 'user version\n');
    assert.equal(await baselines.lookupMode('note.txt'), undefined);
    await writeFile(file, 'agent version\n');
    const changes = await baselines.changes();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, 'update');
    assert.equal(changes[0]?.previousText, 'user version\n');
    assert.equal(changes[0]?.previousMode, undefined, 'a failed mode read is never recorded as an absent file');
    assert.equal(Object.hasOwn(changes[0]!, 'mode'), false, 'a failed current mode read is omitted');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a malformed Git status path cannot read an outside file or fabricate a baseline', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-baseline-outside-path-'));
  const outsidePath = path.resolve(cwd, '../user-data.txt');
  const files = {
    async lstat(candidate: string) {
      assert.notEqual(candidate, outsidePath, 'outside workspace metadata must not be read');
      return lstat(candidate);
    },
    async readFile(candidate: string) {
      assert.notEqual(candidate, outsidePath, 'outside workspace contents must not be read');
      return readFile(candidate);
    },
  };
  try {
    let statuses = 0;
    const baselines = await captureGitBaselines(cwd, async (_root, args) => {
      if (args[0] === 'status') { statuses += 1; return '?? ../user-data.txt\0'; }
      if (args[0] === 'rev-parse') return undefined;
      assert.fail(`unexpected Git command: ${args.join(' ')}`);
    }, files);
    assert.ok(baselines);
    assert.equal(await baselines.lookup('../user-data.txt'), undefined);
    assert.equal(await baselines.lookupMode('../user-data.txt'), undefined);
    assert.deepEqual(await baselines.changes(), [{ path: '../user-data.txt', kind: 'add' }]);
    assert.equal(statuses, 2);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
