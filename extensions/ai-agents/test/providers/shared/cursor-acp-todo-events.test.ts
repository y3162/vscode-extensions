import assert from 'node:assert/strict';

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';

import type { AgentUpdate, TurnOptions } from '../../../src/types.js';

async function fixture(name: string, scenario: Scenario): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `ai-agents-round9-${name}-`));
  const cwd = path.join(root, 'workspace');
  const command = path.join(root, 'synthetic-agent.cjs');
  await mkdir(cwd);
  await writeFile(command, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = path.dirname(process.cwd());
const scenario = ${JSON.stringify(scenario)};
const parentThread = 'round9-parent';
let turnNumber = 0;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => fs.appendFileSync(path.join(root, 'requests.jsonl'), JSON.stringify(value) + '\n');
const complete = (id) => emit({ method: 'turn/completed', params: { threadId: parentThread, turn: { id, status: 'completed' } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  log(request);
  if (request.id !== undefined && !request.method) return;
  if (request.method === 'initialize') { emit({ id: request.id, result: {} }); return; }
  if (request.method === 'initialized') return;
  if (request.method === 'authenticate') { emit({ id: request.id, result: {} }); return; }
  if (request.method === 'session/new') {
    emit({ id: request.id, result: { sessionId: 'round9-acp' } });
    if (scenario === 'acp-todos') setTimeout(() => {
      emit({ method: 'cursor/update_todos', params: { toolCallId: 'empty-round9', todos: [] } });
      emit({ method: 'cursor/update_todos', params: { toolCallId: 'nonempty-round9', todos: [{ content: 'asserted todo', status: 'completed' }] } });
      fs.writeFileSync(path.join(root, 'todos-finished'), 'yes');
    }, 10);
    return;
  }
  if (request.method === 'session/prompt' && scenario === 'acp-empty-todos') {
    emit({ method: 'cursor/update_todos', params: { toolCallId: 'empty-live-round9', todos: [] } });
    emit({ method: 'cursor/update_todos', params: { toolCallId: 'nonempty-live-round9', todos: [{ content: 'live todo', status: 'completed' }] } });
    emit({ method: 'cursor/update_todos', params: { todos: [{ content: 'fallback id todo', status: 'pending' }] } });
    emit({ id: request.id, result: {} });
    return;
  }
  if (request.method === 'thread/start') {
    emit({ id: request.id, result: { thread: { id: parentThread, historyMode: 'paginated' } } });
    return;
  }
  if (request.method === 'thread/list') {
    if (scenario === 'child-notifications') emit({ method: 'item/updated', params: { threadId: 'child-known', item: {
      id: 'reentrant-activity', type: 'subAgentActivity', agentThreadId: 'child-known', kind: 'started',
    } } });
    if (scenario === 'thread-list-empty') emit({ id: request.id, result: { data: null, threads: 'malformed' } });
    else emit({ id: request.id, result: { data: [
      { thread: { id: 'from-data', title: 'Data branch', updatedAt: 'today' } },
      { thread: { id: 'data-id-title-fallback', title: '', preview: 5 } },
    ] } });
    return;
  }
  if (request.method === 'thread/turns/list') {
    if (request.params.threadId === 'round9-branch') emit({ id: request.id, result: { data: [{ id: 'source-one' }] } });
    else emit({ id: request.id, result: { data: [{ id: 'source-one' }, { id: 'source-two' }] } });
    return;
  }
  if (request.method === 'thread/fork') { emit({ id: request.id, result: { thread: { id: 'round9-branch' } } }); return; }
  if (request.method === 'thread/backgroundTerminals/list') { emit({ id: request.id, result: { data: [] } }); return; }
  if (request.method === 'turn/start') {
    const id = 'round9-turn-' + (++turnNumber);
    emit({ id: request.id, result: { turn: { id } } });
    if (scenario === 'command-present') setTimeout(() => {
      emit({ method: 'item/updated', params: { threadId: parentThread, item: {
        id: 'complete-command-fields', type: 'commandExecution', processId: 'round9-process',
        command: 'printf output', status: 'completed', aggregatedOutput: 'command output', exitCode: 0,
      } } });
      complete(id);
    }, 12);
    else if (scenario === 'command-missing-name') setTimeout(() => {
      emit({ method: 'item/updated', params: { threadId: parentThread, item: {
        id: 'command-without-name', type: 'commandExecution', processId: 'round9-process', status: 'running',
      } } });
      complete(id);
    }, 12);
    else if (scenario === 'child-notifications') setTimeout(() => {
      emit({ method: 'item/started', params: { threadId: parentThread, item: {
        id: 'child-activity', type: 'subAgentActivity', agentThreadId: 'child-known', kind: 'started',
      } } });
      emit({ method: 'item/updated', params: { threadId: parentThread, item: {
        id: 'child-state', type: 'subAgentActivity', agentThreadId: 'child-state-string', kind: 'mystery',
        agentsStates: { 'child-state-string': { status: 'completed' } },
      } } });
      emit({ method: 'item/updated', params: { threadId: parentThread, item: {
        id: 'child-state-missing', type: 'subAgentActivity', agentThreadId: 'child-state-missing',
        agentsStates: { 'child-state-missing': { status: 12 } },
      } } });
      emit({ method: 'item/updated', params: { threadId: 'child-known', item: { id: 'child-preview', type: 'agentMessage', text: 'known child update' } } });
      emit({ method: 'turn/completed', params: { threadId: 'child-known', turn: { id: 'known-completion' } } });
      emit({ method: 'turn/started', params: { threadId: 'child-known', turn: { id: 'known-start' } } });
      complete(id);
    }, 12);
    else setTimeout(() => complete(id), 12);
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

async function assertChildExited(f: Fixture): Promise<void> {
  const pid = Number(await readFile(path.join(f.root, 'server.pid'), 'utf8').catch(() => '0'));
  if (!pid) return;
  let alive = false;
  try { process.kill(pid, 0); alive = true; }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
  assert.equal(alive, false);
}

interface Fixture { root: string; cwd: string; command: string; cleanup(): Promise<void> }

type Scenario = 'command-present' | 'command-missing-name' | 'child-notifications' | 'generic' | 'thread-list-empty' | 'acp-todos' | 'acp-empty-todos';

test('ACP empty todo events are omitted while nonempty todos are emitted', async () => {
  const f = await fixture('acp-todo-condition', 'acp-todos');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd: f.cwd, model: '', storagePath: path.join(f.root, 'storage'), agentPath: f.command, backend: 'acp' });
  try {
    await waitFor(async () => (await readFile(path.join(f.root, 'todos-finished'), 'utf8').catch(() => '')) === 'yes');
    const transcript: Array<{ id: string; meta?: { todos?: Array<{ content: string; status: string }> } }> = [];
    await session.loadTranscript?.((message) => transcript.push(message));
    assert.deepEqual(transcript.map((item) => [item.id, item.meta?.todos]), [
      ['nonempty-round9', [{ content: 'asserted todo', status: 'completed' }]],
    ]);
  } finally {
    await session.dispose(); await assertChildExited(f); await f.cleanup();
  }
});

test('ACP omits empty live todos and emits nonempty updates with explicit or fallback ids', async () => {
  const f = await fixture('empty-live-todo', 'acp-empty-todos');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd: f.cwd, model: '', storagePath: path.join(f.root, 'storage'), agentPath: f.command, backend: 'acp' });
  const updates: AgentUpdate[] = [];
  try {
    await session.run('todo id fallbacks', new AbortController().signal, (update) => updates.push(update));
    assert.equal(updates.some((update) => update.id === 'empty-live-round9'), false);
    assert.deepEqual(updates, [{
      id: 'nonempty-live-round9', role: 'status', backendTurnId: 'acp-turn-1',
      text: 'completed: live todo', meta: { type: 'todo', todos: [{ content: 'live todo', status: 'completed' }] },
    }, {
      id: 'todos', role: 'status', backendTurnId: 'acp-turn-1',
      text: 'pending: fallback id todo', meta: { type: 'todo', todos: [{ content: 'fallback id todo', status: 'pending' }] },
    }]);
  } finally {
    await session.dispose(); await assertChildExited(f); await f.cleanup();
  }
});
