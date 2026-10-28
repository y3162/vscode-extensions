import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCodexCliHistory } from '../../../src/providers/codex-cli-history.js';

type Replies = Record<string, unknown[]>;

const sourceTurns = [
  { id: 'turn-0', items: [{ type: 'userMessage', content: [{ text: 'first' }] }] },
  { id: 'turn-1', items: [{ type: 'agentMessage', text: 'answer' }, { type: 'userMessage', content: [{ text: 'second' }, { type: 'image' }] }] },
];

async function history(t: TestContext, replies: Replies, options: { sandbox?: string; apiKey?: string } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-cli-history-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = path.join(cwd, 'codex-stub.cjs');
  await writeFile(executable, `
const readline = require('node:readline');
const replies = ${JSON.stringify(replies)};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (replies[request.method] || []).shift();
  const result = reply && reply.$error
    ? { id: request.id, error: { message: reply.$error } }
    : { id: request.id, result: reply === undefined ? {} : reply };
  process.stdout.write(JSON.stringify(result) + '\\n');
});
`);
  return createCodexCliHistory({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, codexPath: executable,
    ...options,
  });
}

function base(extra: Replies = {}): Replies {
  return {
    initialize: [{}],
    'thread/resume': [{ thread: { id: 'thread-1', historyMode: 'paginated' } }],
    ...extra,
  };
}

test('Codex CLI history reads paginated prompts and checks a turn-boundary fork', async (t) => {
  const listed = await history(t, base({
    'thread/turns/list': [
      { data: [sourceTurns[0]], nextCursor: 'page-2' },
      { data: [sourceTurns[1]], nextCursor: null },
    ],
  }), { sandbox: 'read-only', apiKey: 'test-key' });
  assert.deepEqual(await listed.turns('thread-1'), [
    { id: 'turn-0', prompt: 'first' }, { id: 'turn-1', prompt: 'second' },
  ]);

  const fork = await history(t, base({
    'thread/turns/list': [{ data: sourceTurns }, { data: [sourceTurns[0]] }],
    'thread/fork': [{ thread: { id: 'branch-1' } }],
  }));
  assert.equal(await fork.forkBeforeTurn('thread-1', 'turn-1', ['turn-0', 'turn-1']), 'branch-1');

  const terminals = await history(t, base({
    'thread/backgroundTerminals/list': [
      { data: [{ processId: 'p1', command: 'sleep 1' }], nextCursor: 'more' },
      { terminals: [{ id: 'p2' }], nextCursor: null },
    ],
  }));
  assert.deepEqual(await terminals.terminals('thread-1'), [
    { processId: 'p1', status: 'running', command: 'sleep 1' },
    { processId: 'p2', status: 'running' },
  ]);
});

test('Codex CLI history lists threads and returns the full turn transcript', async (t) => {
  const listed = await history(t, {
    initialize: [{}],
    'thread/list': [{ data: [{ id: 'thread-1', title: 'Hello', updatedAt: '2026-10-18T00:00:00.000Z' }] }],
  });
  const sessions = await listed.listThreads?.();
  assert.equal(sessions?.[0]?.id, 'thread-1');
  assert.equal(sessions?.[0]?.title, 'Hello');
  assert.equal(sessions?.[0]?.titleSource, 'provider');
  assert.equal(sessions?.[0]?.backend, 'cli');
  assert.equal(sessions?.[0]?.provider, 'codex');
  assert.ok(sessions?.[0]?.cwd);

  const transcript = await history(t, base({
    'thread/turns/list': [{ data: sourceTurns, nextCursor: null }],
  }));
  const messages = await transcript.transcript?.('thread-1');
  assert.deepEqual(messages?.map((message) => ({ role: message.role, text: message.text })), [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'answer' },
    { role: 'user', text: 'second' },
  ]);
});

test('Codex CLI history refuses incomplete, stale, and unverifiable responses', async (t) => {
  const cases: Array<{ name: string; replies: Replies; operation: 'turns' | 'fork' | 'terminals'; error: RegExp }> = [
    { name: 'initialization', replies: { initialize: [{ $error: 'no initialization' }] }, operation: 'turns', error: /no initialization/ },
    { name: 'wrong thread', replies: { initialize: [{}], 'thread/resume': [{ thread: { id: 'other', historyMode: 'paginated' } }] }, operation: 'turns', error: /安全に分岐/ },
    { name: 'legacy history', replies: { initialize: [{}], 'thread/resume': [{ thread: { id: 'thread-1', historyMode: 'legacy' } }] }, operation: 'turns', error: /安全に分岐/ },
    { name: 'missing turn page', replies: base({ 'thread/turns/list': [{}] }), operation: 'turns', error: /検証できません/ },
    { name: 'missing turn id', replies: base({ 'thread/turns/list': [{ data: [{}] }] }), operation: 'turns', error: /ターンID/ },
    { name: 'repeated turn cursor', replies: base({ 'thread/turns/list': [{ data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }] }), operation: 'turns', error: /カーソル/ },
    { name: 'stale tail', replies: base({ 'thread/turns/list': [{ data: sourceTurns }] }), operation: 'fork', error: /一致しません/ },
    { name: 'missing target', replies: base({ 'thread/turns/list': [{ data: sourceTurns }] }), operation: 'fork', error: /履歴にありません/ },
    { name: 'missing branch id', replies: base({ 'thread/turns/list': [{ data: sourceTurns }], 'thread/fork': [{}] }), operation: 'fork', error: /作成できません/ },
    { name: 'same branch id', replies: base({ 'thread/turns/list': [{ data: sourceTurns }], 'thread/fork': [{ thread: { id: 'thread-1' } }] }), operation: 'fork', error: /作成できません/ },
    { name: 'branch length mismatch', replies: base({ 'thread/turns/list': [{ data: sourceTurns }, { data: [] }], 'thread/fork': [{ thread: { id: 'branch-1' } }] }), operation: 'fork', error: /直前で終わっていません/ },
    { name: 'branch content mismatch', replies: base({ 'thread/turns/list': [{ data: sourceTurns }, { data: [{ id: 'wrong' }] }], 'thread/fork': [{ thread: { id: 'branch-1' } }] }), operation: 'fork', error: /直前で終わっていません/ },
    { name: 'missing terminal page', replies: base({ 'thread/backgroundTerminals/list': [{}] }), operation: 'terminals', error: /確認できません/ },
    { name: 'missing terminal id', replies: base({ 'thread/backgroundTerminals/list': [{ data: [{}] }] }), operation: 'terminals', error: /IDがありません/ },
    { name: 'repeated terminal cursor', replies: base({ 'thread/backgroundTerminals/list': [{ data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }] }), operation: 'terminals', error: /カーソル/ },
  ];
  for (const row of cases) {
    const client = await history(t, row.replies);
    const operation = row.operation === 'turns' ? client.turns('thread-1')
      : row.operation === 'terminals' ? client.terminals('thread-1')
        : client.forkBeforeTurn('thread-1', row.name === 'missing target' ? 'absent' : 'turn-1', row.name === 'stale tail' ? ['wrong'] : undefined);
    await assert.rejects(operation, row.error, row.name);
  }
});
