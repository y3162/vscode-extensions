import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';

type Scenario = 'missing' | 'confirmed-still-listed' | 'unconfirmed-still-listed' | 'unconfirmed-removed';

async function makeSession(scenario: Scenario) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-confirmation-'));
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const scenario = ${JSON.stringify(scenario)};
let terminalLists = 0;
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'thread-1', historyMode: 'paginated' } } });
  else if (request.method === 'thread/backgroundTerminals/list') {
    terminalLists += 1;
    const present = scenario === 'confirmed-still-listed' || scenario === 'unconfirmed-still-listed'
      || (scenario === 'unconfirmed-removed' && terminalLists === 1);
    emit({ id: request.id, result: { data: present ? [{ processId: 'proc-1', itemId: 'item-1', command: 'node watch.js' }] : [] } });
  }
  else if (request.method === 'thread/backgroundTerminals/terminate') {
    emit({ id: request.id, result: { terminated: scenario === 'confirmed-still-listed' } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server',
  });
  return {
    session,
    async cleanup() {
      await session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test('App Server interrupt confirms absence before treating an unacknowledged termination as complete', async () => {
  const missing = await makeSession('missing');
  try {
    await assert.rejects(missing.session.interruptBackgroundTerminal!('proc-1'), /終了しています/);
  } finally {
    await missing.cleanup();
  }

  const removed = await makeSession('unconfirmed-removed');
  try {
    await removed.session.interruptBackgroundTerminal?.('proc-1');
    assert.deepEqual(await removed.session.listBackgroundTerminals?.(), []);
  } finally {
    await removed.cleanup();
  }
});

test('App Server reports a still-listed terminal when termination was not acknowledged', async () => {
  const session = await makeSession('unconfirmed-still-listed');
  try {
    await assert.rejects(session.session.interruptBackgroundTerminal!('proc-1'), /not interrupted/);
    const terminals = await session.session.listBackgroundTerminals?.();
    assert.deepEqual(terminals?.map((terminal) => [terminal.processId, terminal.status]), [['proc-1', 'running']]);
  } finally {
    await session.cleanup();
  }
});

test('App Server accepts a positive termination acknowledgment even while a listing is stale', async () => {
  const session = await makeSession('confirmed-still-listed');
  try {
    await session.session.interruptBackgroundTerminal?.('proc-1');
    assert.deepEqual((await session.session.listBackgroundTerminals?.())?.map((terminal) => terminal.processId), ['proc-1']);
  } finally {
    await session.cleanup();
  }
});

async function makeAcpSession() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-acp-model-shapes-'));
  const command = path.join(cwd, 'synthetic-acp.cjs');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' || request.method === 'authenticate') emit({ id: request.id, result: {} });
  else if (request.method === 'session/new') emit({ id: request.id, result: {
    sessionId: 'acp-shape-session',
    models: { currentModelId: 'by-id', availableModels: [
      { name: 'missing id is ignored' },
      { modelId: 'by-id' },
      { modelId: 'by-name[fast=true]', name: 'By name' },
      { modelId: 'auto[context=1]', name: 'Automatic' },
    ] },
  } });
  else if (request.method === 'session/set_config_option') emit({ id: request.id, result: { configOptions: [{ id: 'model', currentValue: request.params.value }] } });
  else if (request.method === 'session/list') emit({ id: request.id, result: { sessions: { malformed: true } } });
  else if (request.method === 'session/prompt') {
    fs.appendFileSync(path.join(process.cwd(), 'prompts.log'), 'prompt\\n');
    emit({ id: request.id, result: { stopReason: 'end_turn' } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o755);
  const session = await createCursorAcpSession({
    provider: 'cursor', cwd, model: 'by-id', storagePath: cwd, agentPath: command, backend: 'acp',
  });
  return {
    cwd,
    session,
    async cleanup() {
      await session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test('ACP filters malformed model catalog entries and applies advertised variants by id, name, and auto alias', async () => {
  const { session, cwd, cleanup } = await makeAcpSession();
  try {
    await assert.rejects(async () => {
      await session.setModel!({ provider: 'cursor', cwd, model: 'missing id is ignored' });
    }, /has not advertised/);
    await session.setModel?.({ provider: 'cursor', cwd, model: 'By name', modelParams: [{ id: 'fast', value: 'true' }] });
    const updates: import('../../../src/types.js').AgentUpdate[] = [];
    await session.run('model switch', new AbortController().signal, (update) => updates.push(update), undefined, {
      intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: '', modelParams: [] },
    });
    assert.deepEqual(await session.listSessions?.(), []);
    assert.equal(await readFile(path.join(cwd, 'prompts.log'), 'utf8'), 'prompt\n');
    assert.equal(updates.some((update) => update.final), false, 'a prompt with no assistant message does not invent a final reply');
  } finally {
    await cleanup();
  }
});

test('ACP does not send a prompt for a signal that was already aborted', async () => {
  const { session, cwd, cleanup } = await makeAcpSession();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(session.run!('must not send', controller.signal, () => {}), { name: 'AbortError' });
    await assert.rejects(readFile(path.join(cwd, 'prompts.log'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanup();
  }
});
