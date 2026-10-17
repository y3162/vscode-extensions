import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate, ChatMessage, PermissionDecision } from '../../../src/types.js';

const server = String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const decisions = [];
const starts = [];
let skillsCalls = 0;
let mcpCalls = 0;
const history = [{ id: 'saved-turn', items: [
  { type: 'subAgentActivity', newThreadId: 'saved-child', agentPath: '/agents/saved', kind: 'completed', agentsStates: { 'saved-child': { status: 'completed' } } },
  { type: 'userMessage', id: 'user-1', text: 'saved prompt' },
  { type: 'errorMessage', id: 'error-1', message: 'saved error' },
  { type: 'agentMessage', id: 'answer-1', text: 'saved answer', phase: 'final_answer' },
  { type: 'webSearch', id: 'search-1', query: 'saved query' },
  { type: 'agentMessage', id: 'empty-1', text: '' },
] }];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: {
    thread: { id: 'thread-1', historyMode: 'paginated', turns: history },
    sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never', instructionSources: ['AGENTS.md'],
  } });
  else if (request.method === 'thread/turns/list') emit({ id: request.id, result: { data: null } });
  else if (request.method === 'skills/list') {
    if (++skillsCalls === 1) emit({ id: request.id, result: { data: [
      { skills: [{ name: 'nested' }, { skills: [{ name: 'deep' }] }] }, { name: 'direct' }, { skills: 'ignored' },
    ] } });
    else emit({ id: request.id, error: { message: 'skills unavailable' } });
  }
  else if (request.method === 'mcpServerStatus/list') {
    if (++mcpCalls === 1) emit({ id: request.id, result: { data: [{ name: 'server' }, { name: 5 }] } });
    else emit({ id: request.id, error: { message: 'MCP unavailable' } });
  }
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: request.params.cursor
    ? { data: [{ processId: 'proc-2', command: 'second' }], nextCursor: '' }
    : { data: [{ processId: 'proc-1', command: 'first' }], nextCursor: 'page-2' } });
  else if (request.method === 'turn/start') {
    starts.push(request.params);
    fs.writeFileSync(path.join(__dirname, 'turn-starts.json'), JSON.stringify(starts));
    const turnId = request.params.input[0].text === 'approve' ? 'approval-turn' : 'events-turn';
    if (turnId === 'approval-turn') {
      emit({ id: 50, method: 'item/permissions/requestApproval', params: { approvalId: 'network-1', reason: 'allow network' } });
      emit({ id: request.id, result: { turn: { id: turnId } } });
    } else {
      emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId } } });
      const item = (type, fields = {}) => emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type, ...fields } } });
      item('fileChange', { id: 'file-1', changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' }] });
      item('subAgentActivity', { id: 'child-1', agentThreadId: 'child-run', agentPath: '/agents/run', kind: 'started', prompt: 'inspect' });
      emit({ method: 'turn/completed', params: { threadId: 'child-run', turn: { id: 'child-turn', status: 'completed', durationMs: 3 } } });
      item('plan', { id: 'plan-1', text: 'structured plan' });
      item('todoList', { id: 'todos-1', items: [{ content: 'verify', status: 'pending' }] });
      item('reasoning', { id: 'reason-1', text: 'thinking' });
      item('agentMessage', { id: 'answer-2', text: 'live answer', phase: 'final_answer' });
      item('agentMessage', { id: 'empty-2', text: '' });
      item('error', { id: 'error-2', message: 'visible error' });
      item('error', { id: 'empty-error', message: '' });
      item('webSearch', { id: 'tool-1', query: 'live query' });
      emit({ method: 'turn/diff/updated', params: { threadId: 'thread-1', turn: { id: turnId }, diff:
        'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n' } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: turnId } } });
    }
  } else if (request.id === 50) {
    decisions.push(request.result.decision);
    emit({ id: 51, method: 'item/fileChange/requestApproval', params: { itemId: 'file-1', command: 'write file', reason: 'approve file' } });
  } else if (request.id === 51) {
    decisions.push(request.result.decision);
    emit({ id: 52, method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } });
  } else if (request.id === 52) {
    decisions.push(request.result.decision);
    fs.writeFileSync(path.join(__dirname, 'decisions.json'), JSON.stringify(decisions));
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'approval-turn', status: 'completed' } } });
  } else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;

test('App Server normalizes nested history and instruction data, terminal pages, live items, and approval requests', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-server-contracts-'));
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  await writeFile(command, server, { mode: 0o600 });
  const permissions: { id: string; title: string; detail: string; kind: string }[] = [];
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server',
    interactions: {
      async requestPermission(request) {
        permissions.push(request);
        return (request.kind === 'network' ? 'allow-session' : request.kind === 'write' ? 'deny' : 'allow-once') satisfies PermissionDecision;
      },
      async requestPlan() { return 'rejected'; },
      async requestAnswers() { return {}; },
    },
  });
  try {
    const replay: ChatMessage[] = [];
    await session.loadTranscript?.((message) => replay.push(message));
    assert.equal(replay.find((message) => message.role === 'user')?.text, 'saved prompt');
    assert.equal(replay.find((message) => message.role === 'error')?.text, 'saved error');
    assert.equal(replay.find((message) => message.final)?.text, 'saved answer');
    assert.equal(replay.filter((message) => message.meta?.subagent?.id === 'saved-child').length, 1);
    assert.equal(replay.find((message) => message.text === 'saved query')?.role, 'tool');

    assert.equal(await session.instructions?.(), 'AGENTS.md: AGENTS.md\nSkills: nested, deep, direct\nMCP: server');
    assert.equal(await session.instructions?.(), 'AGENTS.md: AGENTS.md\nSkills: none\nMCP: none');
    const terminals = await session.listBackgroundTerminals?.();
    assert.deepEqual(terminals?.map(({ processId, command: name }) => [processId, name]), [
      ['proc-1', 'first'], ['proc-2', 'second'],
    ]);

    const updates: AgentUpdate[] = [];
    await session.setMode?.('plan');
    await session.run('events', new AbortController().signal, (update) => updates.push(update));
    const starts = JSON.parse(await readFile(path.join(cwd, 'turn-starts.json'), 'utf8')) as { approvalPolicy: string; collaborationMode: { mode: string }; sandboxPolicy: { type: string; networkAccess?: boolean } }[];
    assert.deepEqual({ approvalPolicy: starts[0]?.approvalPolicy, collaborationMode: starts[0]?.collaborationMode.mode, sandboxPolicy: starts[0]?.sandboxPolicy }, {
      approvalPolicy: 'never', collaborationMode: 'plan', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    assert.equal(updates.some((update) => update.meta?.files?.some((file) => file.path.endsWith('/src/a.ts') && file.additions === 1 && file.deletions === 1)), true);
    assert.equal(updates.some((update) => update.meta?.subagent?.id === 'child-run' && update.meta.subagent.status === 'completed'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'plan' && update.meta.plan?.markdown === 'structured plan'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'todo' && update.meta.todos?.[0]?.content === 'verify'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'thinking' && update.text === 'thinking'), true);
    assert.equal(updates.some((update) => update.final && update.text === 'live answer'), true);
    assert.equal(updates.some((update) => update.role === 'error' && update.text === 'visible error'), true);
    assert.equal(updates.some((update) => update.text === 'websearch: live query' && update.tool?.status === 'completed'), true);
    const diff = updates.find((update) => update.id === 'events-turn:diff');
    assert.deepEqual(diff?.meta?.files?.map((file) => file.path), ['src/a.ts']);
    assert.equal(updates.some((update) => update.id === 'empty-2' || update.id === 'empty-error'), false);

    await session.setMode?.('agent');
    await session.run('approve', new AbortController().signal, () => {});
    assert.deepEqual(permissions, [
      { id: 'network-1', title: 'allow network', detail: 'allow network', kind: 'network' },
      { id: 'file-1', title: 'write file', detail: 'approve file', kind: 'write' },
      { id: 'npm test', title: 'npm test', detail: 'npm test', kind: 'shell' },
    ]);
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'decisions.json'), 'utf8')), ['acceptForSession', 'decline', 'accept']);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
