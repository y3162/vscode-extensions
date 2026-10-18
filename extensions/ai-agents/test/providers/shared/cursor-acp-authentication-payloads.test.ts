import assert from 'node:assert/strict';

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';

import type { AgentUpdate, PermissionDecision } from '../../../src/types.js';

async function makeAcp(mode: 'edges' | 'hang-auth' | 'auth-error') {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-acp-round5-'));
  const command = path.join(cwd, 'synthetic-acp.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const scenario = ${JSON.stringify(mode)};
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let pending;
function agent(text) { emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', text } } }); }
function finish() { agent('protocol complete'); emit({ id: pending, result: { stopReason: 'end_turn' } }); pending = undefined; }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'authenticate') {
    if (scenario === 'hang-auth') return;
    if (scenario === 'auth-error') { emit({ id: request.id, error: { message: 'synthetic authentication transport failure' } }); return; }
    emit({ id: request.id, result: {} });
  }
  else if (request.method === 'session/new') emit({ id: request.id, result: {
    sessionId: 'acp-round5',
    configOptions: [{ id: 'model', currentValue: 'base', options: [{ value: 4 }, { name: 'missing value' }, { value: 'advertised', name: 8 }] }],
  } });
  else if (request.method === 'session/set_mode') emit({ id: request.id, result: {} });
  else if (request.method === 'session/set_config_option') emit({ id: request.id, result: { configOptions: [{ id: 'model', currentValue: request.params.value }] } });
  else if (request.method === 'session/prompt') {
    pending = request.id;
    emit({ method: 'session/update', params: { update: {} } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', text: 'content fallback' } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: [] } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'plan', text: 'plan content fallback' } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', text: 'thought content fallback' } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'user_message', text: 'ignored live user chunk' } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', status: 'running', content: [{ type: 'diff' }] } } });
    emit({ method: 'cursor/update_todos', params: { toolCallId: 'todo-list', todos: [{ text: 'fallback todo' }] } });
    emit({ method: 'cursor/update_todos', params: { todos: [] } });
    emit({ id: 41, method: 'session/request_permission', params: { toolCall: { kind: 'other' } } });
  }
  else if (request.id === 41) emit({ id: 42, method: 'cursor/create_plan', params: { name: 3, overview: null, plan: 5, todos: 'invalid', phases: 'invalid' } });
  else if (request.id === 42) emit({ id: 43, method: 'cursor/ask_question', params: { questions: [
    { id: 'bad-prompt', prompt: 3 }, { id: 'good', prompt: 'Choose', options: 'invalid' }, { id: '', prompt: 'skip' },
  ] } });
  else if (request.id === 43) emit({ id: 44, method: 'cursor/ask_question', params: { questions: 'invalid' } });
  else if (request.id === 44) finish();
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { cwd, command, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('ACP accepts malformed optional payload fields with safe defaults and reports the resulting updates', async () => {
  const { cwd, command, cleanup } = await makeAcp('edges');
  const permissions: Array<{ title: string; kind: string; detail: string }> = [];
  const answers: Array<{ id: string; questions: unknown[] }> = [];
  const identities: string[] = [];
  const session = await createCursorAcpSession({
    provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command, backend: 'acp',
    interactions: {
      async requestPermission(request) { permissions.push(request); return 'allow-once' satisfies PermissionDecision; },
      async requestPlan() { return 'rejected'; },
      async requestAnswers(request) { answers.push({ id: request.id, questions: request.questions }); return {}; },
    },
    onIdentity: (identity) => identities.push(identity.title),
  });
  try {
    await session.setModel?.({ provider: 'cursor', cwd, model: 'advertised' });
    const updates: AgentUpdate[] = [];
    await session.run('', new AbortController().signal, (update) => updates.push(update));
    assert.deepEqual(permissions, [{ id: 'Tool', title: 'Tool', kind: 'other', detail: 'Tool' }]);
    assert.deepEqual(answers.map((entry) => [entry.id, entry.questions.length]), [['question', 1], ['question', 0]]);
    assert.equal(updates.some((update) => update.meta?.type === 'todo' && update.meta.todos?.[0]?.content === 'fallback todo'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'plan' && update.text === 'plan content fallback'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'thinking' && update.text === 'thought content fallback'), true);
    assert.equal(updates.some((update) => update.meta?.type === 'files'), false, 'a diff without a path is discarded');
    assert.equal(updates.some((update) => update.text === 'content fallback'), true);
    assert.deepEqual(identities, ['Cursor ACP', 'Cursor ACP']);
  } finally {
    await session.dispose();
    await cleanup();
  }
});

test('ACP authentication transport errors remain distinguishable from user cancellation', async () => {
  const { cwd, command, cleanup } = await makeAcp('auth-error');
  try {
    await assert.rejects(
      createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command }),
      /synthetic authentication transport failure/,
    );
  } finally {
    await cleanup();
  }
});

test('ACP aborts authentication promptly and preserves the AbortError classification', async () => {
  const { cwd, command, cleanup } = await makeAcp('hang-auth');
  const controller = new AbortController();
  try {
    const pending = createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    await cleanup();
  }
});
