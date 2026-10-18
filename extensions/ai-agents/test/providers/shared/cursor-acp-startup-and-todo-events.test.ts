import assert from 'node:assert/strict';

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';

async function makeFixture(name: string, scenario: Scenario = 'generic', options: { reportedModel?: string; historyMode?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `ai-agents-${name}-`));
  const cwd = path.join(root, 'workspace');
  const command = path.join(root, 'synthetic-protocol.cjs');
  await mkdir(cwd);
  const config = JSON.stringify({ scenario, ...options });
  await writeFile(command, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const config = ${config};
const root = path.dirname(process.cwd());
fs.writeFileSync(path.join(root, 'server.pid'), String(process.pid));
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => fs.appendFileSync(path.join(root, 'requests.jsonl'), JSON.stringify(value) + '\n');
const parentThread = 'round8-parent';
let branchReads = 0;
let pendingQuestionTurn;
let turnCount = 0;
const complete = (id, status = 'completed') => emit({ method: 'turn/completed', params: { threadId: parentThread, turn: { id, status } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  log(request);
  if (request.id !== undefined && !request.method) {
    if (request.id === 61 && pendingQuestionTurn) {
      complete(pendingQuestionTurn);
      pendingQuestionTurn = undefined;
    }
    return;
  }
  if (request.method === 'initialize') { emit({ id: request.id, result: {} }); return; }
  if (request.method === 'initialized') return;
  if (request.method === 'authenticate') {
    if (config.scenario !== 'acp-hold-auth') emit({ id: request.id, result: {} });
    return;
  }
  if (request.method === 'session/new') {
    if (config.scenario === 'acp-hold-new') return;
    emit({ id: request.id, result: { sessionId: 'round8-acp-session' } });
    if (config.scenario === 'acp-todos') setTimeout(() => {
      emit({ method: 'cursor/update_todos', params: { toolCallId: 'empty-list', todos: [] } });
      emit({ method: 'cursor/update_todos', params: { toolCallId: 'one-item', todos: [{ text: 'Keep this todo' }] } });
      fs.writeFileSync(path.join(root, 'todos-sent'), 'yes');
    }, 10);
    return;
  }
  if (request.method === 'thread/start') {
    const thread = { id: parentThread, historyMode: config.historyMode ?? 'paginated' };
    if (config.reportedModel) thread.model = config.reportedModel;
    emit({ id: request.id, result: { thread } });
    return;
  }
  if (request.method === 'thread/list') {
    if (config.scenario === 'list-fallback') emit({ id: request.id, result: { data: 'malformed', threads: [
      {}, { id: 'fallback-id', title: '', preview: 9 }, { id: 'preview-title', preview: 'Readable title' },
    ] } });
    else emit({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'thread/turns/list') {
    const id = request.params.threadId;
    if (id === 'round8-branch') {
      branchReads += 1;
      emit({ id: request.id, result: { data: ['source-one'].map((value) => ({ id: value })) } });
    } else emit({ id: request.id, result: { data: [{ id: 'source-one' }, { id: 'source-two' }] } });
    return;
  }
  if (request.method === 'thread/fork') {
    emit({ id: request.id, result: { thread: { id: 'round8-branch' } } });
    return;
  }
  if (request.method === 'thread/backgroundTerminals/list') {
    if (config.scenario === 'terminal-dispose') {
      const response = JSON.stringify({ id: request.id, result: { data: [] } });
      const notification = JSON.stringify({ method: 'item/started', params: { threadId: parentThread, item: { id: 'dispose-trigger', type: 'mcpToolCall', text: 'dispose after response' } } });
      process.stdout.write(response + '\n' + notification + '\n');
    } else emit({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/start') {
    turnCount += 1;
    const id = 'round8-turn-' + turnCount;
    const prompt = request.params.input?.[0]?.text;
    if (config.scenario === 'rpc-error' && prompt === 'reject-error') {
      emit({ id: request.id, result: { turn: { id } } });
      setTimeout(() => emit({ method: 'error', params: { threadId: parentThread, turnId: id, error: { message: 'synthetic pending turn failure' } } }), 15);
      return;
    }
    if (config.scenario === 'question-empty') {
      emit({ id: request.id, result: { turn: { id } } });
      pendingQuestionTurn = id;
      setTimeout(() => emit({ id: 61, method: 'item/tool/requestUserInput', params: { itemId: 'empty-question', questions: [{ id: 'missing-prompt' }] } }), 10);
      return;
    }
    if (config.scenario === 'command-absent') {
      emit({ id: request.id, result: { turn: { id } } });
      setTimeout(() => {
        emit({ method: 'item/updated', params: { threadId: parentThread, item: { id: 'sparse-command', type: 'commandExecution', processId: 'synthetic-process', command: 'printf sparse' } } });
        complete(id);
      }, 15);
      return;
    }
    if (config.scenario === 'subagent-status') {
      emit({ id: request.id, result: { turn: { id } } });
      setTimeout(() => {
        emit({ method: 'item/started', params: { threadId: parentThread, item: { id: 'retained', type: 'subAgentActivity', agentThreadId: 'child-retained', kind: 'started' } } });
        emit({ method: 'turn/completed', params: { threadId: 'child-retained', turn: { id: 'child-turn', status: 'failed' } } });
        emit({ method: 'item/updated', params: { threadId: parentThread, item: { id: 'retained', type: 'subAgentActivity', agentThreadId: 'child-retained', kind: 'completed', agentsStates: { 'child-retained': { status: 'running' } } } } });
        emit({ method: 'item/started', params: { threadId: parentThread, item: { id: 'unknown', type: 'subAgentActivity', agentThreadId: 'child-unknown', kind: 'mystery' } } });
        emit({ method: 'item/updated', params: { threadId: 'child-unknown', item: { id: 'state-fallback', type: 'agentMessage', text: 'child remains unknown' } } });
        complete(id);
      }, 15);
      return;
    }
    if (config.scenario === 'rename-without-old-path') {
      emit({ id: request.id, result: { turn: { id } } });
      setTimeout(() => {
        emit({ method: 'item/completed', params: { threadId: parentThread, item: { id: 'rename-without-source', type: 'fileChange', changes: [{ path: 'moved.txt', kind: 'rename' }] } } });
        complete(id);
      }, 15);
      return;
    }
    emit({ method: 'turn/started', params: { threadId: parentThread, turn: { id } } });
    emit({ id: request.id, result: { turn: { id } } });
    setTimeout(() => complete(id), 10);
    return;
  }
  if (request.method === 'turn/interrupt') { emit({ id: request.id, result: {} }); return; }
  if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  await chmod(command, 0o700);
  return { root, cwd, command, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await check(), true, 'synthetic protocol did not reach the expected state');
}

async function log(fixture: Fixture): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path.join(fixture.root, 'requests.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function assertProcessExited(fixture: Fixture): Promise<void> {
  const pid = Number(await readFile(path.join(fixture.root, 'server.pid'), 'utf8').catch(() => '0'));
  if (!pid) return;
  let alive = false;
  try { process.kill(pid, 0); alive = true; }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
  assert.equal(alive, false, 'synthetic protocol process must exit after disposal');
}

interface Fixture {
  root: string;
  cwd: string;
  command: string;
  cleanup(): Promise<void>;
}

type Scenario = 'generic' | 'rpc-error' | 'command-absent' | 'subagent-status' | 'question-empty'
  | 'terminal-dispose' | 'rename-without-old-path' | 'list-fallback' | 'fork-history-fallback'
  | 'acp-hold-auth' | 'acp-hold-new' | 'acp-todos';

test('ACP rethrows a native AbortError from authentication and disposes before session creation', async () => {
  const fixture = await makeFixture('acp-native-auth-abort', 'acp-hold-auth');
  const controller = new AbortController();
  const opening = createCursorAcpSession({ provider: 'cursor', cwd: fixture.cwd, model: '', storagePath: path.join(fixture.root, 'storage'), agentPath: fixture.command, backend: 'acp', signal: controller.signal });
  try {
    await waitFor(async () => (await log(fixture)).some((item) => item.method === 'authenticate'));
    controller.abort();
    await assert.rejects(opening, { name: 'AbortError' });
    assert.equal((await log(fixture)).some((item) => item.method === 'session/new'), false);
    await assertProcessExited(fixture);
  } finally { await fixture.cleanup(); }
});

test('ACP wraps a non-Error outer startup rejection and never creates a partial session', async () => {
  const fixture = await makeFixture('acp-string-session-start', 'acp-hold-new');
  const controller = new AbortController();
  const opening = createCursorAcpSession({ provider: 'cursor', cwd: fixture.cwd, model: '', storagePath: path.join(fixture.root, 'storage'), agentPath: fixture.command, backend: 'acp', signal: controller.signal });
  try {
    await waitFor(async () => (await log(fixture)).some((item) => item.method === 'session/new'));
    controller.abort('outer startup sentinel');
    await assert.rejects(opening, /outer startup sentinel/);
    assert.equal((await log(fixture)).some((item) => item.method === 'session/set_mode'), false);
    await assertProcessExited(fixture);
  } finally { await fixture.cleanup(); }
});

test('ACP omits an empty todo update and records a valid synthetic todo', async () => {
  const fixture = await makeFixture('acp-empty-todos', 'acp-todos');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd: fixture.cwd, model: '', storagePath: path.join(fixture.root, 'storage'), agentPath: fixture.command, backend: 'acp' });
  try {
    await waitFor(async () => (await readFile(path.join(fixture.root, 'todos-sent'), 'utf8').catch(() => '')) === 'yes');
    const transcript: Array<{ id: string; meta?: { todos?: Array<{ content: string; status: string }> } }> = [];
    await session.loadTranscript?.((message) => transcript.push(message));
    assert.deepEqual(transcript.map((message) => [message.id, message.meta?.todos]), [
      ['one-item', [{ content: 'Keep this todo', status: 'pending' }]],
    ]);
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});
