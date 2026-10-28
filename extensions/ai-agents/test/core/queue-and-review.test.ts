import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { isInsideWorkspace, mergeFileChanges, revertChange } from '../../src/change-review.js';
import { previousTextFromDiff } from '../../src/diff-stats.js';
import { capabilitiesFor } from '../../src/capabilities.js';
import { builtinCommand, expandPrompt, resolveInside } from '../../src/context-text.js';
import { sanitizeImages } from '../../src/images.js';
import { upsertSession } from '../../src/session-index.js';
import type { Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('queued prompts wait until Stop and can then be sent without dropping the queue', { timeout: 5000 }, async () => {
  const entered = deferred();
  const seen: string[] = [];
  const controller = new ChatController(selection, async () => ({
    async run(prompt, signal) {
      seen.push(prompt);
      if (seen.length === 1) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('long request');
  await entered.promise;
  controller.enqueue('  later  ', { displayText: 'later' });
  assert.equal(controller.snapshot().queue.length, 1);
  controller.stop();
  await running;
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().queue[0]?.text, 'later');
  controller.sendQueued(controller.snapshot().queue[0]!.id);
  const deadline = Date.now() + 1000;
  while (seen.length < 2) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(seen, ['long request', 'later']);
  assert.equal(controller.snapshot().queue.length, 0);
  assert.equal(controller.snapshot().messages.filter((message) => message.role === 'user').at(-1)?.text, 'later');
});

test('permission requests stay pending until the user chooses, and session allows are remembered', async () => {
  let controller!: ChatController;
  controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      const decision = await controller.requestPermission({ id: 'perm-1', title: 'npm test', detail: 'npm test', kind: 'shell' });
      emit({ id: 'decision', role: 'tool', text: decision });
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('needs approval');
  const deadline = Date.now() + 1000;
  while (!controller.snapshot().pendingPermission) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.snapshot().status, 'waiting_approval');
  assert.equal(controller.snapshot().pendingPermission?.title, 'npm test');
  controller.resolvePermission('perm-1', 'allow-session');
  await running;
  assert.equal(controller.snapshot().messages.at(-1)?.text, 'allow-session');
  assert.equal(await controller.requestPermission({ id: 'perm-2', title: 'npm test', detail: 'npm test', kind: 'shell' }), 'allow-once');
  assert.equal(controller.snapshot().pendingPermission, null);
});

test('usage updates do not create an empty transcript row and file baselines stay with the first capture', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } });
      emit({ id: 'files', role: 'tool', text: 'updated src/main.ts', meta: { type: 'files', files: [{ path: 'src/main.ts', kind: 'update', previousText: 'old' }] } });
      emit({ id: 'files', role: 'tool', text: 'updated src/main.ts', meta: { type: 'files', files: [{ path: 'src/main.ts', kind: 'update', previousText: 'new' }] } });
    },
    async dispose() {},
  }), () => {});
  await controller.send('hello');
  assert.equal(controller.snapshot().messages.some((message) => message.text === ''), false);
  assert.equal(controller.snapshot().usage?.inputTokens, 3);
  assert.equal(controller.snapshot().changes[0]?.previousText, 'old');
  assert.deepEqual(mergeFileChanges([], [{ path: 'a.ts', kind: 'add', previousText: null }])[0]?.previousText, null);
});

test('workspace path checks reject traversal and symlink escapes, and previous text can be restored', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-review-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ai-agents-outside-'));
  try {
    assert.equal(isInsideWorkspace(path.join(root, 'src', 'a.ts'), [root]), true);
    assert.equal(isInsideWorkspace(path.join(root, '..', 'secret'), [root]), false);
    assert.equal(resolveInside(root, '../secret'), undefined);
    const file = path.join(root, 'note.txt');
    await writeFile(file, 'changed');
    await revertChange({ path: file, kind: 'update', previousText: 'original' }, [root]);
    assert.equal(await readFile(file, 'utf8'), 'original');
    const link = path.join(root, 'escape.txt');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), link);
    await assert.rejects(revertChange({ path: link, kind: 'update', previousText: 'nope' }, [root]), /ワークスペース外/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Revert preserves final newlines, CRLF bytes and captured file permissions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-exact-revert-'));
  const file = path.join(cwd, 'note.txt');
  try {
    await writeFile(file, 'changed');
    await chmod(file, 0o600);
    await revertChange({ path: file, kind: 'update', previousText: 'original\r\nsecond\r\n', previousMode: 0o755 }, [cwd]);
    assert.deepEqual(await readFile(file), Buffer.from('original\r\nsecond\r\n'));
    assert.equal((await stat(file)).mode & 0o777, 0o755);
    await writeFile(file, 'changed again');
    await revertChange({ path: 'note.txt', kind: 'update', previousText: 'relative restore\n' }, [cwd]);
    assert.deepEqual(await readFile(file), Buffer.from('relative restore\n'));
    await writeFile(file, 'changed');
    await chmod(file, 0o755);
    await revertChange({ path: 'note.txt', kind: 'update', previousText: 'preserve mode' }, [cwd]);
    assert.equal((await stat(file)).mode & 0o777, 0o755);
    const deleted = path.join(cwd, 'deleted.txt');
    const diff = 'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-original\n';
    await revertChange({ path: deleted, kind: 'delete', previousText: previousTextFromDiff(diff, 'delete'), previousMode: 0o755 }, [cwd]);
    assert.deepEqual(await readFile(deleted), Buffer.from('original\n'));
    assert.equal((await stat(deleted)).mode & 0o777, 0o755);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('prompt expansion reads workspace files and ignores paths outside the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-context-'));
  try {
    await writeFile(path.join(root, 'readme.md'), 'hello context');
    const expanded = await expandPrompt('Look at @readme.md', root);
    assert.match(expanded, /hello context/);
    assert.equal(await expandPrompt('plain request', root), 'plain request');
    const outside = await expandPrompt('Read @../secret.txt', root);
    assert.doesNotMatch(outside, /secret contents/);
    assert.deepEqual(builtinCommand('/review the diff'), { name: 'review', rest: 'the diff' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('image attachments are limited to four safe base64 images', () => {
  assert.deepEqual(sanitizeImages([{ mimeType: 'image/png', data: Buffer.from('png').toString('base64'), name: 'a.png' }])[0]?.mimeType, 'image/png');
  assert.throws(() => sanitizeImages([{ mimeType: 'text/plain', data: Buffer.from('x').toString('base64') }]), /画像/);
  assert.equal(capabilitiesFor('cursor', 'acp').questions, true);
  assert.equal(capabilitiesFor('cursor', 'cli').interactiveApproval, false);
  assert.equal(capabilitiesFor('codex', 'app-server').review, true);
  assert.equal(capabilitiesFor('codex', 'cli').steer, false);
  assert.equal(upsertSession([{ id: 'a', title: 'old', updatedAt: '', provider: 'codex' }], { id: 'a', title: 'new', updatedAt: 'now', provider: 'codex' })[0]?.title, 'new');
});

test('rename restoration moves the captured text back and never overwrites a recreated original', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rename-review-'));
  const original = path.join(cwd, 'old.txt');
  const moved = path.join(cwd, 'new.txt');
  const change = { path: moved, oldPath: original, kind: 'rename' as const, previousText: 'user original\n' };
  try {
    await writeFile(moved, 'agent edit\n');
    await writeFile(original, 'new user content\n');
    await assert.rejects(revertChange(change, [cwd]), /EEXIST/);
    assert.equal(await readFile(original, 'utf8'), 'new user content\n');
    assert.equal(await readFile(moved, 'utf8'), 'agent edit\n');
    await rm(original);
    await revertChange(change, [cwd]);
    assert.equal(await readFile(original, 'utf8'), 'user original\n');
    await assert.rejects(readFile(moved));
    await writeFile(moved, 'agent edit\n');
    await assert.rejects(revertChange({ ...change, oldPath: path.join(cwd, '..', 'outside.txt') }, [cwd]), /ワークスペース外/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('relative and absolute file events update one change row', async () => {
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      emit({ id: 'native', role: 'tool', text: '', meta: { type: 'files', files: [{ path: '/workspace/note.txt', kind: 'update', previousText: 'old' }] } });
      emit({ id: 'git', role: 'tool', text: '', meta: { type: 'files', files: [{ path: 'note.txt', kind: 'update', additions: 1, deletions: 1 }] } });
    }, async dispose() {},
  }), () => {});
  await controller.send('edit');
  assert.equal(controller.snapshot().changes.length, 1);
  assert.equal(controller.snapshot().changes[0]?.previousText, 'old');
  await controller.dispose();
});
