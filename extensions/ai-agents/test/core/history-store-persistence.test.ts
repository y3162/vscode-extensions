import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from '../../src/capabilities.js';

import { HistoryStore, type SavedConversation } from '../../src/history-store.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

function selection(cwd = '/work'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function chatState(cwd = '/work', messages: ChatState['messages'] = [{ id: 'm1', role: 'user', text: 'hello' }]): ChatState {
  return {
    selection: selection(cwd), busy: false, messages, queue: [], status: 'idle', usage: null,
    changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
  };
}

function saved(id: string, state = chatState()): SavedConversation {
  return { version: 1, id, sessionId: `session-${id}`, updatedAt: '2026-10-17T00:00:00.000Z', controls: defaultControls('codex', 'cli'), state };
}

test('history load rejects non-ENOENT failures, invalid records, and still reads a valid sibling', async () => {
  const root = await tempDir('ai-agents-history-load-');
  const outside = await tempDir('ai-agents-history-outside-');
  const outsideFile = path.join(outside, 'untouched.txt');
  await writeFile(outsideFile, 'keep', { mode: 0o640 });
  try {
    const valid = saved('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await writeFile(path.join(root, `${valid.id}.json`), JSON.stringify(valid), { mode: 0o600 });
    const broken: Array<[string, unknown]> = [
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { ...valid, version: 2, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
      ['cccccccc-cccc-cccc-cccc-cccccccccccc', { ...valid, id: 'not-the-file-name' }],
      ['dddddddd-dddd-dddd-dddd-dddddddddddd', { ...valid, id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', state: { ...valid.state, selection: undefined } }],
      ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', { ...valid, id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', state: { ...valid.state, messages: 'nope' } }],
      ['ffffffff-ffff-ffff-ffff-ffffffffffff', { ...valid, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', state: { ...valid.state, turns: null } }],
      ['11111111-1111-1111-1111-111111111111', { ...valid, id: '11111111-1111-1111-1111-111111111111', controls: { ...valid.controls, backend: undefined } }],
      ['22222222-2222-2222-2222-222222222222', { ...valid, id: '22222222-2222-2222-2222-222222222222', updatedAt: 1 }],
      ['33333333-3333-3333-3333-333333333333', { ...valid, id: '33333333-3333-3333-3333-333333333333', state: { ...valid.state, selection: { provider: 'codex', model: 'm' } } }],
      ['44444444-4444-4444-4444-444444444444', { ...valid, id: '44444444-4444-4444-4444-444444444444', state: { ...valid.state, selection: { provider: 'other', cwd: '/work', model: 'm' } } }],
      ['55555555-5555-5555-5555-555555555555', { ...valid, id: '55555555-5555-5555-5555-555555555555', controls: { ...valid.controls, backend: 'other' } }],
      ['66666666-6666-6666-6666-666666666666', { ...valid, id: '66666666-6666-6666-6666-666666666666', state: { ...valid.state, terminals: 'nope' } }],
      ['77777777-7777-7777-7777-777777777777', { ...valid, id: '77777777-7777-7777-7777-777777777777', state: { ...valid.state, plan: undefined } }],
      ['88888888-8888-8888-8888-888888888888', { ...valid, id: '88888888-8888-8888-8888-888888888888', state: { ...valid.state, messages: [{ id: 'm', role: 'nope', text: 'x' }] } }],
    ];
    for (const [id, value] of broken) await writeFile(path.join(root, `${id}.json`), JSON.stringify(value), { mode: 0o600 });
    await writeFile(path.join(root, 'notes.txt'), 'ignore me');
    const store = new HistoryStore(root);
    await store.load();
    assert.equal(store.errors.length, broken.length);
    assert.equal(store.get(valid.id)?.state.messages[0]?.text, 'hello');
    assert.equal(store.get(valid.sessionId!)?.id, valid.id);
    assert.equal(store.get('missing'), undefined);
    assert.equal(store.summaries().find((item) => item.conversationId === valid.id)?.title, 'hello');
    const untitled = saved('99999999-9999-9999-9999-999999999999', chatState('/work', []));
    await writeFile(path.join(root, `${untitled.id}.json`), JSON.stringify(untitled));
    const titled = new HistoryStore(root);
    await titled.load();
    assert.equal(titled.summaries().find((item) => item.conversationId === untitled.id)?.title, 'Chat');
    for (const [id] of broken) assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8') !== '', true);
    const blocked = path.join(root, 'not-a-directory');
    await writeFile(blocked, 'file');
    await assert.rejects(new HistoryStore(blocked).load(), { code: 'ENOTDIR' });
    const missing = new HistoryStore(path.join(root, 'missing-dir'));
    await missing.load();
    assert.deepEqual(missing.summaries(), []);
    await chmod(root, 0o000);
    await assert.rejects(new HistoryStore(root).load(), { code: 'EACCES' });
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    assert.equal(await readFile(outsideFile, 'utf8'), 'keep');
    assert.equal((await stat(outsideFile)).mode & 0o777, 0o640);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a superseded 500ms history debounce writes only the latest snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await tempDir('ai-agents-history-debounce-');
  try {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const store = new HistoryStore(root);
    const busy = (text: string): SavedConversation => ({ ...saved(id), state: { ...chatState('/work', [{ id: 'm', role: 'user', text }]), busy: true } });
    store.schedule(busy('first'));
    t.mock.timers.tick(499);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT');
    store.schedule(busy('second'));
    t.mock.timers.tick(100);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT');
    t.mock.timers.tick(400);
    const tails = (store as unknown as { tails: Map<string, Promise<void>> }).tails;
    await Promise.all([...tails.values()]);
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'second');
    store.schedule({ ...saved(id), state: chatState('/work', [{ id: 'm', role: 'user', text: 'immediate' }]) });
    await Promise.all([...tails.values()]);
    t.mock.timers.tick(500);
    await Promise.all([...tails.values()]);
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'immediate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('history flush and clear keep the previous file when the write or unlink fails', async () => {
  const root = await tempDir('ai-agents-history-flush-');
  try {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const failures: unknown[] = [];
    const store = new HistoryStore(root, (error) => failures.push(error));
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'original' }])));
    store.schedule(saved(other));
    await store.flush();
    const original = await readFile(path.join(root, `${id}.json`), 'utf8');
    await chmod(root, 0o500);
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'replacement' }])));
    await assert.rejects(store.flush(), { code: 'EACCES' });
    await chmod(root, 0o700);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8'), original);
    assert.equal(failures.length > 0, true);
    assert.equal(store.get(id)?.state.messages[0]?.text, 'replacement');
    await store.flush();
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'replacement');

    const destination = path.join(root, `${id}.json`);
    await rm(destination);
    await mkdir(destination);
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'after rename failure' }])));
    await assert.rejects(store.flush(), (error: NodeJS.ErrnoException) => error.code === 'EISDIR' || error.code === 'EPERM');
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
    await rm(destination, { recursive: true });
    await store.flush();
    assert.equal(JSON.parse(await readFile(destination, 'utf8')).state.messages[0].text, 'after rename failure');

    const clean = new HistoryStore(root);
    await clean.load();
    const file = path.join(root, `${other}.json`);
    await rm(file);
    await mkdir(file);
    await assert.rejects(clean.clear(other), (error: NodeJS.ErrnoException) => error.code === 'EPERM' || error.code === 'EISDIR');
    assert.equal(clean.get(other)?.id, other);
    assert.equal((await lstat(file)).isDirectory(), true);
    await rm(file, { recursive: true, force: true });
    await clean.clear();
    assert.equal(clean.get(id), undefined);
    assert.equal(clean.get(other), undefined);
    await assert.rejects(readFile(path.join(root, `${id}.json`), 'utf8'), { code: 'ENOENT' });
    await clean.clear(id);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});;;;
