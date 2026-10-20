import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TerminalMonitor } from '../../../src/terminal-monitor.js';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate } from '../../../src/types.js';

async function createFixture(cwd: string, source: string): Promise<string> {
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  await writeFile(command, source);
  await chmod(command, 0o700);
  return command;
}

test('App Server joins early command output to the exact terminal after itemId-to-processId mapping arrives', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-server-terminal-output-'));
  const callsPath = path.join(cwd, 'rpc-calls.json');
  const command = await createFixture(cwd, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const callsPath = path.join(process.cwd(), 'rpc-calls.json');
const rows = [
  { processId: 'synthetic-alpha-process', itemId: 'synthetic-alpha-item', command: 'alpha command', cwd: process.cwd(), osPid: 987654 },
  { processId: 'synthetic-beta-process', itemId: 'synthetic-beta-item', command: 'beta command', cwd: process.cwd(), osPid: 987655 },
  { processId: 'synthetic-gamma-process', itemId: 'synthetic-gamma-item', command: 'gamma command', cwd: process.cwd(), osPid: 987656 },
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
    emit({ method: 'item/started', params: { threadId, turnId: 'synthetic-parent-turn', item: { id: 'synthetic-gamma-item', type: 'commandExecution', command: 'gamma command', processId: 'synthetic-gamma-process', status: 'inProgress', aggregatedOutput: null } } });
    setImmediate(() => {
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'synthetic-parent-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'synthetic-parent-turn' } } });
    });
  }
  else if (request.method === 'thread/backgroundTerminals/list') {
    if (request.params.threadId !== 'synthetic-parent-thread') throw new Error('terminal list was requested for the wrong thread');
    emit({ id: request.id, result: { data: rows, nextCursor: null } });
  }
  else if (request.method === 'thread/items/list') {
    if (request.params.threadId !== 'synthetic-parent-thread') throw new Error('item list was requested for the wrong thread');
    emit({ id: request.id, result: { data: [
      { turnId: 'synthetic-parent-turn', item: { id: 'synthetic-alpha-item', type: 'commandExecution', processId: 'synthetic-alpha-process', command: 'alpha command', status: 'inProgress', aggregatedOutput: 'ALPHA_EARLY\n' } },
      { turnId: 'synthetic-parent-turn', item: { id: 'synthetic-beta-item', type: 'commandExecution', processId: 'synthetic-beta-process', command: 'beta command', status: 'inProgress', aggregatedOutput: 'BETA_EARLY\n' } },
      { turnId: 'synthetic-parent-turn', item: { id: 'synthetic-gamma-item', type: 'commandExecution', processId: 'synthetic-gamma-process', command: 'gamma command', status: 'inProgress', aggregatedOutput: 'GAMMA_SNAPSHOT_ONLY\n' } },
    ], nextCursor: null, backwardsCursor: null } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server' });
  const monitors: TerminalMonitor[] = [];
  const output = new Map<string, string>();
  try {
    await session.run('synthetic terminal output mapping', new AbortController().signal, () => {});
    const rows = await session.listBackgroundTerminals?.();
    assert.deepEqual(rows?.map(({ processId, itemId, output }) => [processId, itemId, output]), [
      ['synthetic-alpha-process', 'synthetic-alpha-item', 'ALPHA_EARLY\n'],
      ['synthetic-beta-process', 'synthetic-beta-item', 'BETA_EARLY\n'],
      ['synthetic-gamma-process', 'synthetic-gamma-item', 'GAMMA_SNAPSHOT_ONLY\n'],
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
    assert.match(output.get('synthetic-gamma-process') ?? '', /GAMMA_SNAPSHOT_ONLY/);

    for (const monitor of monitors) monitor.handleInput('text is not forwarded\r');
    for (const monitor of monitors) monitor.dispose();
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { threadId?: string; processId?: string } });
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1, 'opening monitors does not start another turn');
    assert.ok(calls.some((call) => call.method === 'thread/items/list' && call.params?.threadId === 'synthetic-parent-thread'), 'output reconciliation reads the owning thread item snapshot');
    assert.equal(calls.some((call) => ['process/spawn', 'process/writeStdin', 'process/kill', 'command/exec', 'command/exec/write', 'thread/backgroundTerminals/terminate'].includes(call.method)), false,
      'mirroring and closing the monitor neither starts a process, writes stdin, kills a PID, nor terminates a terminal');
    assert.ok(calls.filter((call) => call.method === 'thread/backgroundTerminals/list').every((call) => call.params?.threadId === 'synthetic-parent-thread'));
  } finally {
    for (const monitor of monitors) monitor.dispose();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('App Server marks terminal output completeness unknown when item reconciliation is unavailable', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-output-unavailable-'));
  const command = await createFixture(cwd, String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'terminal-thread' } } });
  else if (request.method === 'turn/start') {
    const threadId = request.params.threadId;
    emit({ method: 'turn/started', params: { threadId, turn: { id: 'terminal-turn' } } });
    emit({ method: 'item/started', params: { threadId, turnId: 'terminal-turn', item: { id: 'terminal-item', type: 'commandExecution', command: 'synthetic command', processId: 'terminal-process', status: 'inProgress', aggregatedOutput: null } } });
    setImmediate(() => { emit({ method: 'turn/completed', params: { threadId, turn: { id: 'terminal-turn', status: 'completed' } } }); emit({ id: request.id, result: { turn: { id: 'terminal-turn' } } }); });
  }
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [{ processId: 'terminal-process', itemId: 'terminal-item', command: 'synthetic command' }] } });
  else if (request.method === 'thread/items/list') emit({ id: request.id, error: { code: -32601, message: 'Method not found: thread/items/list' } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server' });
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates?.((update) => updates.push(update));
  let monitor: TerminalMonitor | undefined;
  let rendered = '';
  try {
    await session.run('synthetic terminal output failure', new AbortController().signal, () => {});
    const terminal = updates.flatMap((update) => update.meta?.type === 'terminals' ? update.meta.terminals ?? [] : []).at(-1);
    assert.ok(terminal);
    assert.equal(terminal.status, 'running', 'output retrieval failure must not fabricate process failure');
    assert.match(terminal.outputError ?? '', /completeness is unknown/i);
    monitor = new TerminalMonitor(session, terminal, (text) => { rendered += text; }, false);
    monitor.open();
    assert.match(rendered, /Output completeness is unknown/);
    assert.doesNotMatch(rendered, /Process exited/);
  } finally {
    monitor?.dispose();
    unsubscribe?.();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('App Server warns when an item has no aggregate and clears the warning after a complete snapshot arrives', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-output-partial-'));
  const command = await createFixture(cwd, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'partial-thread' } } });
  else if (request.method === 'turn/start') {
    const threadId = request.params.threadId;
    emit({ method: 'turn/started', params: { threadId, turn: { id: 'partial-turn' } } });
    emit({ method: 'item/started', params: { threadId, turnId: 'partial-turn', item: { id: 'partial-item', type: 'commandExecution', command: 'synthetic command', processId: 'partial-process', status: 'inProgress' } } });
    setImmediate(() => { emit({ method: 'turn/completed', params: { threadId, turn: { id: 'partial-turn', status: 'completed' } } }); emit({ id: request.id, result: { turn: { id: 'partial-turn' } } }); });
  }
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [{ processId: 'partial-process', itemId: 'partial-item', command: 'synthetic command' }] } });
  else if (request.method === 'thread/items/list') emit({ id: request.id, result: { data: [{ turnId: 'partial-turn', item: { id: 'partial-item', type: 'commandExecution', processId: 'partial-process', status: 'inProgress', ...(fs.existsSync(path.join(process.cwd(), 'snapshot.flag')) ? { aggregatedOutput: 'RECOVERED_COMPLETE_OUTPUT\n' } : { aggregatedOutput: null }) } }] } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server' });
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates?.((update) => updates.push(update));
  let monitor: TerminalMonitor | undefined;
  let rendered = '';
  try {
    await session.run('synthetic partial terminal output', new AbortController().signal, () => {});
    const terminal = (await session.listBackgroundTerminals?.())?.find((row) => row.processId === 'partial-process');
    assert.ok(terminal);
    assert.match(terminal.outputError ?? '', /no complete output snapshot/i);
    monitor = new TerminalMonitor(session, terminal, (text) => { rendered += text; }, false);
    monitor.open();
    assert.match(rendered, /Output completeness is unknown/);

    // A later authoritative snapshot proves the warning is recoverable and not sticky.
    await writeFile(path.join(cwd, 'snapshot.flag'), '1');
    const recovered = await session.listBackgroundTerminals?.();
    assert.equal(recovered?.find((row) => row.processId === 'partial-process')?.output, 'RECOVERED_COMPLETE_OUTPUT\n');
    assert.equal(recovered?.find((row) => row.processId === 'partial-process')?.outputError, undefined);
    assert.match(rendered, /Runtime output snapshot restored/);
    assert.ok(updates.some((update) => update.meta?.type === 'terminals' && update.meta.terminals?.some((row) => row.processId === 'partial-process' && row.outputError)));
  } finally {
    monitor?.dispose();
    unsubscribe?.();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('App Server reconnects to the same running terminal after reload and resolves its item through bounded history pages', { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-output-reload-'));
  const callsPath = path.join(cwd, 'rpc-calls.json');
  const command = await createFixture(cwd, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const callsPath = path.join(process.cwd(), 'rpc-calls.json');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(callsPath, JSON.stringify({ method: request.method, params: request.params }) + '\n');
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/resume') emit({ id: request.id, result: { thread: { id: 'reloaded-thread', historyMode: 'paginated' } } });
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [{ processId: 'existing-process', itemId: 'existing-item', command: 'already running command' }] } });
  else if (request.method === 'thread/items/list' && !request.params.turnId && !request.params.cursor) emit({ id: request.id, result: { data: [{ turnId: 'older-turn', item: { id: 'irrelevant-item', type: 'agentMessage' } }], nextCursor: 'history-page-2' } });
  else if (request.method === 'thread/items/list' && !request.params.turnId && request.params.cursor === 'history-page-2') emit({ id: request.id, result: { data: [{ turnId: 'terminal-turn', item: { id: 'existing-item', type: 'commandExecution' } }], nextCursor: null } });
  else if (request.method === 'thread/items/list' && request.params.turnId === 'terminal-turn' && !request.params.cursor) emit({ id: request.id, result: { data: [{ turnId: 'terminal-turn', item: { id: 'another-item', type: 'commandExecution', aggregatedOutput: 'other output' } }], nextCursor: 'turn-page-2' } });
  else if (request.method === 'thread/items/list' && request.params.turnId === 'terminal-turn' && request.params.cursor === 'turn-page-2') emit({ id: request.id, result: { data: [{ turnId: 'terminal-turn', item: { id: 'existing-item', type: 'commandExecution', command: 'already running command', processId: 'existing-process', status: 'inProgress', aggregatedOutput: 'RESTORED_INITIAL_OUTPUT\n' } }], nextCursor: null } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command, backend: 'app-server', resumeId: 'reloaded-thread' });
  try {
    const rows = await session.listBackgroundTerminals?.();
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0]?.processId, 'existing-process');
    assert.equal(rows?.[0]?.output, 'RESTORED_INITIAL_OUTPUT\n');
    assert.equal(rows?.[0]?.outputError, undefined);
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { threadId?: string; turnId?: string; cursor?: string } });
    assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1);
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, 0, 'reconnect must not rerun the command or its parent turn');
    assert.ok(calls.some((call) => call.method === 'thread/items/list' && call.params?.cursor === 'history-page-2'));
    assert.ok(calls.some((call) => call.method === 'thread/items/list' && call.params?.turnId === 'terminal-turn' && call.params?.cursor === 'turn-page-2'));
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
