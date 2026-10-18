import assert from 'node:assert/strict';

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

import type { AgentUpdate, PermissionDecision } from '../../../src/types.js';

test('App Server child polling reconciles a completed child and retains its result preview', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-child-poll-'));
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'parent-thread', historyMode: 'paginated' } } });
  else if (request.method === 'turn/start') {
    emit({ method: 'item/started', params: { threadId: 'parent-thread', item: { type: 'subAgentActivity', id: 'spawn-1', agentThreadId: 'child-thread', agentPath: '/agents/review', kind: 'started' } } });
    emit({ method: 'turn/completed', params: { threadId: 'parent-thread', turn: { id: 'parent-turn', status: 'completed' } } });
    emit({ id: request.id, result: { turn: { id: 'parent-turn', status: 'completed' } } });
  }
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [] } });
  else if (request.method === 'thread/read' && request.params.threadId === 'child-thread') emit({ id: request.id, result: { thread: {
    status: { type: 'idle' }, turns: [{ status: 'completed', items: [
      { type: 'agentMessage', text: 'child answer' }, { type: 'reasoning', content: 'hidden thought' },
    ] }],
  } } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: '', storagePath: cwd, codexPath: command });
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run!('start child', new AbortController().signal, () => {});
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-thread' && update.meta.subagent.status === 'running'), true);
    const deadline = Date.now() + 2800;
    while (!background.some((update) => update.meta?.subagent?.id === 'child-thread' && update.meta.subagent.status === 'completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const completed = background.filter((update) => update.meta?.subagent?.id === 'child-thread' && update.meta.subagent.status === 'completed').at(-1);
    assert.ok(completed, 'a completed child turn discovered by thread/read is reconciled');
    assert.equal(completed.meta?.subagent?.resultPreview, 'child answer');
    assert.equal(completed.meta?.subagent?.endedAt !== undefined, true);
  } finally {
    unsubscribe();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
