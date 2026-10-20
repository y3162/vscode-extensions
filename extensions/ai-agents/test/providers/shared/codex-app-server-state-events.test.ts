import { createGitFixture, snapshotGitFixture } from '../../support/git-fixture.js';
import assert from 'node:assert/strict';


import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

import type { AgentUpdate, TurnOptions } from '../../../src/types.js';

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

function appOptions(fixture: Fixture, model = 'configured-model', modelParams?: Array<{ id: string; value: string }>) {
  return {
    provider: 'codex' as const, cwd: fixture.cwd, model, modelParams,
    storagePath: path.join(fixture.root, 'storage'), codexPath: fixture.command, backend: 'app-server' as const,
  };
}

function turnSelection(fixture: Fixture, model: string, modelParams: Array<{ id: string; value: string }> = []): TurnOptions {
  return { intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd: fixture.cwd, model, modelParams } };
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

test('App Server rejects an active RPC turn error and remains usable afterward', async () => {
  const fixture = await makeFixture('app-server-pending-error', 'rpc-error');
  const session = await createCodexAppServerSession(appOptions(fixture));
  try {
    await assert.rejects(session.run('reject-error', new AbortController().signal, () => {}), /synthetic pending turn failure/);
    await session.run('after-error', new AbortController().signal, () => {});
    assert.equal((await log(fixture)).filter((item) => item.method === 'turn/start').length, 2);
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server maps a sparse command to a safe completed update without inventing output fields', async () => {
  const fixture = await makeFixture('app-server-command-absent', 'command-absent');
  const session = await createCodexAppServerSession(appOptions(fixture));
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run('sparse command', new AbortController().signal, () => {});
    const update = background.find((item) => item.id === 'sparse-command');
    assert.equal(update?.text, 'printf sparse');
    assert.equal(update?.tool?.status, 'completed', 'missing backend status is represented as unknown then safely normalized');
    assert.equal('exitCode' in (update?.tool ?? {}), false);
    assert.equal('output' in (update ?? {}), false);
  } finally {
    unsubscribe();
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server retains completed child failure against stale activity and preserves unknown status', async () => {
  const fixture = await makeFixture('app-server-subagent-state', 'subagent-status');
  const session = await createCodexAppServerSession(appOptions(fixture));
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run('subagent status', new AbortController().signal, () => {});
    const retained = background.filter((item) => item.meta?.subagent?.id === 'child-retained').at(-1)?.meta?.subagent;
    assert.equal(retained?.status, 'error', 'a stale running activity must not erase the child failure');
    const unknown = background.filter((item) => item.meta?.subagent?.id === 'child-unknown').at(-1)?.meta?.subagent;
    assert.equal(unknown?.status, 'unknown', 'an unrecognized activity kind remains unknown');
    assert.equal(unknown?.resultPreview, 'child remains unknown');
  } finally {
    unsubscribe();
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server filters an identified question with no question or header prompt', async () => {
  const fixture = await makeFixture('app-server-question-empty', 'question-empty');
  const received: Array<{ id: string; questions: Array<{ id: string; prompt: string }> }> = [];
  const session = await createCodexAppServerSession({
    ...appOptions(fixture),
    interactions: {
      async requestPermission() { return 'deny'; },
      async requestPlan() { return 'rejected'; },
      async requestAnswers(request) { received.push(request); return {}; },
    },
  });
  try {
    await session.run('question fallback', new AbortController().signal, () => {});
    assert.deepEqual(received, [{ id: 'empty-question', questions: [] }]);
    const answer = (await log(fixture)).find((item) => item.id === 61 && !item.method);
    assert.deepEqual(answer?.result, { answers: {} });
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server listSessions falls back to threads and to the id when title fields are unusable', async () => {
  const fixture = await makeFixture('app-server-list-fallback', 'list-fallback');
  const session = await createCodexAppServerSession(appOptions(fixture));
  try {
    assert.deepEqual((await session.listSessions?.())?.map(({ id, title }) => [id, title]), [
      ['fallback-id', 'fallback-id'], ['preview-title', 'Readable title'],
    ]);
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server fork inherits the verified history mode when the fork omits it', async () => {
  const fixture = await makeFixture('app-server-fork-history', 'fork-history-fallback');
  const session = await createCodexAppServerSession(appOptions(fixture));
  try {
    const branch = await session.forkBeforeTurn?.('source-two');
    assert.equal(branch, 'round8-branch');
    session.activateFork?.(branch!);
    assert.equal(session.rewindUnsupportedReason?.(), undefined, 'the paginated source history capability follows the owned branch');
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server applies configured model and effort fallbacks when turn selections omit them', async () => {
  const fixture = await makeFixture('app-server-model-fallback', 'generic', { reportedModel: 'reported-model' });
  const session = await createCodexAppServerSession({ ...appOptions(fixture, 'configured-model', [{ id: 'modelReasoningEffort', value: 'high' }]) });
  try {
    await session.run('no turn selection', new AbortController().signal, () => {});
    await session.run('empty turn selection', new AbortController().signal, () => {}, undefined, turnSelection(fixture, '', [{ id: 'unrelated', value: 'x' }]));
    const requests = (await log(fixture)).filter((item) => item.method === 'turn/start');
    assert.deepEqual(requests.map((item) => ({ model: (item.params as Record<string, unknown>).model, effort: (item.params as Record<string, unknown>).effort })), [
      { model: 'configured-model', effort: 'high' },
      { model: 'configured-model', effort: 'high' },
    ]);
  } finally {
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }

  const reportedFixture = await makeFixture('app-server-thread-model-fallback', 'generic', { reportedModel: 'thread-reported-model' });
  const reportedSession = await createCodexAppServerSession(appOptions(reportedFixture, ''));
  try {
    await reportedSession.run('thread model fallback', new AbortController().signal, () => {}, undefined, turnSelection(reportedFixture, ''));
    const params = (await log(reportedFixture)).find((item) => item.method === 'turn/start')?.params as Record<string, unknown>;
    assert.equal(params.model, 'thread-reported-model');
    assert.equal('effort' in params, false);
  } finally {
    await reportedSession.dispose();
    await assertProcessExited(reportedFixture);
    await reportedFixture.cleanup();
  }
});

test('App Server carries a rename without an oldPath through the Git baseline update', async () => {
  const fixture = await makeFixture('app-server-rename-no-old-path', 'rename-without-old-path');
  await writeFile(path.join(fixture.cwd, 'tracked.txt'), 'before move\n');
  createGitFixture(fixture.cwd);
  snapshotGitFixture(fixture.cwd);
  const session = await createCodexAppServerSession(appOptions(fixture));
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run('rename without origin', new AbortController().signal, () => {});
    const changes = background.find((item) => item.id.startsWith('workspace-changes:'))?.meta?.files;
    const rename = changes?.find((item) => item.path.endsWith('/moved.txt'));
    assert.equal(rename?.kind, 'rename', JSON.stringify(background));
    assert.equal(rename?.oldPath, undefined);
  } finally {
    unsubscribe();
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server ignores a terminal refresh response after disposal begins in the same protocol batch', async () => {
  const fixture = await makeFixture('app-server-terminal-after-dispose', 'terminal-dispose');
  const session = await createCodexAppServerSession(appOptions(fixture));
  const background: AgentUpdate[] = [];
  let disposal: Promise<void> | undefined;
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run('dispose during terminal refresh', new AbortController().signal, (update) => {
      if (update.id === 'dispose-trigger') disposal = session.dispose();
    });
    await disposal;
    assert.equal(background.some((item) => item.meta?.type === 'terminals'), false, 'a disposed refresh does not publish stale terminal state');
    assert.equal((await log(fixture)).some((item) => item.method === 'thread/backgroundTerminals/list'), true);
  } finally {
    unsubscribe();
    await session.dispose();
    await assertProcessExited(fixture);
    await fixture.cleanup();
  }
});
