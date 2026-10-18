import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

import type { AgentUpdate } from '../../../src/types.js';

async function makeAppServer() {
  const cwd = await tempDirectory();
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: {
    threadId: 'server-thread', model: 'reported-model',
    thread: { historyMode: 'paginated', turns: [{ id: 'cached-turn', items: [{ type: 'userMessage', text: 'cached transcript' }] }] },
  } });
  else if (request.method === 'thread/turns/list') emit({ id: request.id, error: { message: 'history list unavailable' } });
  else if (request.method === 'thread/read') emit({ id: request.id, result: { turns: [] } });
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [] } });
  else if (request.method === 'thread/list') emit({ id: request.id, result: { threads: [{ id: 'listed-thread', preview: 'preview title' }, { id: '' }] } });
  else if (request.method === 'turn/start') {
    const id = request.params.input[0].text === 'fail-empty' ? 'fail-turn' : 'edge-turn';
    emit({ method: 'turn/started', params: { threadId: 'server-thread', turn: { id } } });
    if (id === 'fail-turn') emit({ method: 'error', params: { turnId: id, willRetry: false } });
    else {
      const item = (type, fields = {}) => emit({ method: 'item/completed', params: { threadId: 'server-thread', item: { type, ...fields } } });
      item('commandExecution');
      item('fileChange', { changes: { malformed: true } });
      item('todoList', { todos: [{ step: 'fallback todo' }, { text: '' }, null] });
      item('', { id: 'bare-type', content: [{ type: 'text', text: 'bare item' }] });
      item('agentMessage', { id: 'assistant-final', text: 'plain plan', phase: 'final_answer' });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'server-thread' } });
      emit({ method: 'turn/plan/updated', params: { threadId: 'server-thread', plan: [{ step: 'plan fallback' }] } });
      emit({ method: 'turn/diff/updated', params: { threadId: 'server-thread', turn: { id }, diff:
        'diff --git a/new.txt b/new.txt\\n--- /dev/null\\n+++ b/new.txt\\n@@ -0,0 +1 @@\\n+new\\n' } });
      emit({ method: 'turn/completed', params: { threadId: 'server-thread', turn: { id, status: 'completed' } } });
    }
    emit({ id: request.id, result: { turn: { id } } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(command, source);
  await chmod(command, 0o755);
  const identities: string[] = [];
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: '', storagePath: cwd, codexPath: command, backend: 'app-server',
    onIdentity: (identity) => identities.push(identity.title),
  });
  return { cwd, session, identities, async cleanup() {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  } };
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ai-agents-provider-branches-'));
}

test('Codex App Server normalizes replay, listing, todo, diff, model, and identity fallbacks from synthetic protocol data', async () => {
  const { cwd, session, identities, cleanup } = await makeAppServer();
  try {
    const replay: Array<{ id: string; text: string }> = [];
    await session.loadTranscript!((message) => replay.push({ id: message.id, text: message.text }));
    assert.deepEqual(replay.map((message) => message.text), ['cached transcript'], 'a failed history page replays the cached startup transcript');
    assert.deepEqual((await session.listSessions!()).map((item) => [item.id, item.title]), [['listed-thread', 'preview title']]);

    const updates: AgentUpdate[] = [];
    await session.run('', new AbortController().signal, (update) => updates.push(update), undefined, {
      intent: 'plan', mode: 'plan', selection: { provider: 'codex', cwd, model: '' },
    });
    assert.equal(session.sessionId, 'server-thread');
    assert.equal(updates.some((update) => update.id === 'edge-turn:diff' && update.meta?.files?.[0]?.path === 'new.txt'), true);
    assert.equal(updates.some((update) => update.meta?.todos?.[0]?.content === 'fallback todo'), true);
    assert.equal(updates.find((update) => update.id === 'plan-text')?.meta?.plan?.markdown, 'plain plan');
    assert.equal(updates.some((update) => update.id === 'commandexecution' && update.role === 'tool'), true);
    assert.equal(updates.some((update) => update.id === 'tool:bare-type' || update.text === 'tool: bare item'), true);
    assert.deepEqual(identities, ['Codex', 'Codex']);
    await assert.rejects(session.run!('fail-empty', new AbortController().signal, () => {}), /Codex app-server error/);
  } finally {
    await cleanup();
  }
});
