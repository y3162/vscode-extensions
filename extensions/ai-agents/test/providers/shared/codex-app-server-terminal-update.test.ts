import assert from 'node:assert/strict';

import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

async function delayedAppServerFixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-update-'));
  const command = path.join(cwd, 'mock-app-server.cjs');
  const source = `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
let terminalUpdateAfterList = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'synthetic', platformFamily: 'unix' } });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1', historyMode: 'paginated' }, threadId: 'thread-1', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()] }, approvalPolicy: 'never' } });
  else if (request.method === 'turn/start') {
    terminalUpdateAfterList = true;
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-live', status: 'completed' } } });
    send({ id: request.id, result: { turn: { id: 'turn-live', status: 'completed' } } });
  } else if (request.method === 'thread/backgroundTerminals/list') {
    send({ id: request.id, result: { data: [{ itemId: 'live-command', processId: 'proc-live', command: 'initial command' }], nextCursor: null } });
    if (terminalUpdateAfterList) {
      terminalUpdateAfterList = false;
      setTimeout(() => send({ method: 'item/updated', params: { threadId: 'thread-1', item: { type: 'commandExecution', id: 'live-command', processId: 'proc-live', command: 'node watch.js', status: 'inProgress', aggregatedOutput: 'stdout update' } } }), 30);
    }
  } else if (request.id !== undefined) send({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  return { cwd, command, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('Codex App Server updates an already listed live terminal from a delayed item event', { timeout: 10000 }, async () => {
  const { cwd, command, cleanup } = await delayedAppServerFixture();
  const updates: import('../../../src/types.js').AgentUpdate[] = [];
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    await session.run('LIVE_TERMINAL_UPDATE', new AbortController().signal, () => {});
    const deadline = Date.now() + 1500;
    while (!updates.some((update) => update.meta?.terminals?.some((row) => row.processId === 'proc-live' && row.output === 'stdout update')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminalUpdate = updates.filter((update) => update.meta?.terminals?.some((row) => row.processId === 'proc-live')).at(-1);
    const terminal = terminalUpdate?.meta?.terminals?.find((row) => row.processId === 'proc-live');
    assert.deepEqual(terminal && { itemId: terminal.itemId, command: terminal.command, output: terminal.output, status: terminal.status }, {
      itemId: 'live-command', command: 'node watch.js', output: 'stdout update', status: 'inProgress',
    });
    const commandEvent = updates.find((update) => update.role === 'tool' && update.text === 'node watch.js\nstdout update');
    assert.equal(commandEvent?.tool?.status, 'running');
  } finally {
    unsubscribe();
    await session.dispose();
    await cleanup();
  }
});
