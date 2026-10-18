import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TerminalMonitor } from '../../../src/terminal-monitor.js';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

test('App Server joins early command output to the exact terminal after itemId-to-processId mapping arrives', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-server-terminal-output-'));
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  const callsPath = path.join(cwd, 'rpc-calls.json');
  const source = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const callsPath = path.join(process.cwd(), 'rpc-calls.json');
const rows = [
  { processId: 'synthetic-alpha-process', itemId: 'synthetic-alpha-item', command: 'alpha command', cwd: process.cwd(), osPid: 987654 },
  { processId: 'synthetic-beta-process', itemId: 'synthetic-beta-item', command: 'beta command', cwd: process.cwd(), osPid: 987655 },
];
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(callsPath, JSON.stringify({ method: request.method, params: request.params }) + '\n');
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'synthetic-parent-thread', historyMode: 'paginated' } } });
  else if (request.method === 'turn/start') {
    const threadId = request.params.threadId;
    emit({ method: 'turn/started', params: { threadId, turn: { id: 'synthetic-parent-turn' } } });
    // Model output deltas are item-scoped and can arrive before the server publishes
    // the background terminal's processId/itemId mapping.
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId, turnId: 'synthetic-parent-turn', itemId: 'synthetic-alpha-item', delta: 'ALPHA_EARLY\n' } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId, turnId: 'synthetic-parent-turn', itemId: 'synthetic-beta-item', delta: 'BETA_EARLY\n' } });
    setImmediate(() => {
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'synthetic-parent-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'synthetic-parent-turn' } } });
    });
  }
  else if (request.method === 'thread/backgroundTerminals/list') {
    if (request.params.threadId !== 'synthetic-parent-thread') throw new Error('terminal list was requested for the wrong thread');
    emit({ id: request.id, result: { data: rows, nextCursor: null } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;
  await writeFile(command, source);
  await chmod(command, 0o700);
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server',
  });
  const monitors: TerminalMonitor[] = [];
  const output = new Map<string, string>();
  try {
    await session.run('synthetic terminal output mapping', new AbortController().signal, () => {});
    const rows = await session.listBackgroundTerminals?.();
    assert.deepEqual(rows?.map(({ processId, itemId, output }) => [processId, itemId, output]), [
      ['synthetic-alpha-process', 'synthetic-alpha-item', 'ALPHA_EARLY\n'],
      ['synthetic-beta-process', 'synthetic-beta-item', 'BETA_EARLY\n'],
    ]);

    for (const row of rows ?? []) {
      let text = '';
      output.set(row.processId, text);
      const monitor = new TerminalMonitor(session, row, (chunk) => {
        text += chunk;
        output.set(row.processId, text);
      }, false);
      monitors.push(monitor);
      monitor.open();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(output.get('synthetic-alpha-process') ?? '', /ALPHA_EARLY/);
    assert.doesNotMatch(output.get('synthetic-alpha-process') ?? '', /BETA_EARLY/);
    assert.match(output.get('synthetic-beta-process') ?? '', /BETA_EARLY/);
    assert.doesNotMatch(output.get('synthetic-beta-process') ?? '', /ALPHA_EARLY/);

    for (const monitor of monitors) monitor.handleInput('text is not forwarded\r');
    for (const monitor of monitors) monitor.dispose();
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { threadId?: string; processId?: string } });
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1, 'opening monitors does not start another turn');
    assert.equal(calls.some((call) => ['process/spawn', 'process/writeStdin', 'process/kill', 'command/exec', 'command/exec/write', 'thread/backgroundTerminals/terminate'].includes(call.method)), false,
      'mirroring and closing the monitor neither starts a process, writes stdin, kills a PID, nor terminates a terminal');
    assert.ok(calls.filter((call) => call.method === 'thread/backgroundTerminals/list').every((call) => call.params?.threadId === 'synthetic-parent-thread'));
  } finally {
    for (const monitor of monitors) monitor.dispose();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
