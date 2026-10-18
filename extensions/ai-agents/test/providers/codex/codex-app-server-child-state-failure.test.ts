import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate } from '../../../src/types.js';

async function childReadFailureFixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-child-read-failure-'));
  const command = path.join(cwd, 'mock-app-server.cjs');
  const source = `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'synthetic', platformFamily: 'unix' } });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-parent', historyMode: 'paginated' }, sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()] }, approvalPolicy: 'never' } });
  else if (request.method === 'turn/start') {
    send({ method: 'item/started', params: { threadId: 'thread-parent', item: { id: 'child-start', type: 'subAgentActivity', agentThreadId: 'child-running', agentPath: '/tmp/child', kind: 'started' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'parent-turn', status: 'completed' } } });
    send({ id: request.id, result: { turn: { id: 'parent-turn', status: 'completed' } } });
  } else if (request.method === 'thread/backgroundTerminals/list') send({ id: request.id, result: { data: [], nextCursor: null } });
  else if (request.method === 'thread/read') send({ id: request.id, error: { code: -32000, message: 'synthetic child read failure' } });
  else if (request.id !== undefined) send({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { cwd, command, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('Codex App Server marks a running child unknown when background thread/read fails', { timeout: 8000 }, async () => {
  const { cwd, command, cleanup } = await childReadFailureFixture();
  const updates: AgentUpdate[] = [];
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    await session.run('start child and complete parent', new AbortController().signal, () => {});
    const deadline = Date.now() + 6500;
    while (!updates.some((update) => update.meta?.subagent?.id === 'child-running' && update.meta.subagent.status === 'unknown') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const childStates = updates.filter((update) => update.meta?.subagent?.id === 'child-running').map((update) => update.meta!.subagent!.status);
    assert.ok(childStates.includes('running'));
    assert.equal(childStates.at(-1), 'unknown');
  } finally {
    unsubscribe();
    await session.dispose();
    await cleanup();
  }
});
