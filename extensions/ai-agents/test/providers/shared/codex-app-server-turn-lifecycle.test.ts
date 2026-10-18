import assert from 'node:assert/strict';

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

import type { AgentUpdate } from '../../../src/types.js';

async function makeFixture(name: string, options: { holdInitialize?: boolean; holdAuthenticate?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-' + name + '-'));
  const cwd = path.join(root, 'workspace');
  const command = path.join(root, 'synthetic-protocol.cjs');
  await mkdir(cwd);
  await writeFile(command, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const readline = require("node:readline");',
    'const holdInitialize = ' + String(options.holdInitialize === true) + ';',
    'const holdAuthenticate = ' + String(options.holdAuthenticate === true) + ';',
    'const root = process.cwd();',
    'fs.writeFileSync(path.join(root, "server.pid"), String(process.pid));',
    'const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
    'const log = (value) => fs.appendFileSync(path.join(root, "requests.log"), JSON.stringify(value) + "\\n");',
    'const complete = (id, status = "completed") => emit({ method: "turn/completed", params: { threadId: "round7-thread", turn: { id, status } } });',
    'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  log(request);',
    '  if (request.method === "initialize") { if (!holdInitialize) emit({ id: request.id, result: {} }); return; }',
    '  if (request.method === "initialized") return;',
    '  if (request.method === "authenticate") { if (!holdAuthenticate) emit({ id: request.id, result: {} }); return; }',
    '  if (request.method === "session/new") { emit({ id: request.id, result: { sessionId: "round7-acp-session" } }); return; }',
    '  if (request.method === "thread/start") { emit({ id: request.id, result: { thread: { id: "round7-thread", historyMode: "paginated" } } }); return; }',
    '  if (request.method === "thread/backgroundTerminals/list") { emit({ id: request.id, result: { data: [] } }); return; }',
    '  if (request.method === "turn/start") {',
    '    const text = request.params.input?.[0]?.text;',
    '    if (text === "empty-id") { emit({ id: request.id, result: {} }); return; }',
    '    if (text === "saved-output") {',
    '      emit({ method: "turn/started", params: { threadId: "round7-thread", turn: { id: "saved-output-turn" } } });',
    '      emit({ method: "item/updated", params: { threadId: "round7-thread", item: { id: "saved-command", type: "commandExecution", processId: "proc-saved", command: "echo saved", status: "running", aggregatedOutput: "retained output" } } });',
    '      emit({ method: "item/updated", params: { threadId: "round7-thread", item: { id: "saved-command", type: "commandExecution", processId: "proc-saved", command: "echo saved" } } });',
    '      complete("saved-output-turn");',
    '      emit({ id: request.id, result: { turn: { id: "saved-output-turn" } } });',
    '      return;',
    '    }',
    '    if (text === "todo-plan") {',
    '      emit({ method: "turn/started", params: { threadId: "round7-thread", turn: { id: "todo-plan-turn" } } });',
    '      emit({ method: "item/completed", params: { threadId: "round7-thread", item: { id: "plan-todos", type: "todoList", items: null, todos: null, plan: [{ text: "fallback plan step", completed: true }] } } });',
    '      complete("todo-plan-turn");',
    '      emit({ id: request.id, result: { turn: { id: "todo-plan-turn" } } });',
    '      return;',
    '    }',
    '    if (text === "subagent-fallback") {',
    '      emit({ method: "turn/started", params: { threadId: "round7-thread", turn: { id: "subagent-turn" } } });',
    '      emit({ method: "item/started", params: { threadId: "round7-thread", item: { id: "spawn-fallback", type: "collabAgentToolCall", receiverThreadIds: ["child-status"], tool: "inspect" } } });',
    '      emit({ method: "item/updated", params: { threadId: "child-status", item: { id: "nested-start", type: "subAgentActivity", agentThreadId: "grandchild-status", kind: "started" } } });',
    '      emit({ method: "item/agentMessage/delta", params: { threadId: "child-status", delta: "child result" } });',
    '      complete("subagent-turn");',
    '      emit({ id: request.id, result: { turn: { id: "subagent-turn" } } });',
    '      return;',
    '    }',
    '    if (text === "late-abort") { emit({ id: request.id, result: { turn: { id: "late-turn" } } }); return; }',
    '    if (text === "pending-dispose") {',
    '      emit({ method: "turn/started", params: { threadId: "round7-thread", turn: { id: "pending-dispose-turn" } } });',
    '      emit({ id: request.id, result: { turn: { id: "pending-dispose-turn" } } });',
    '      return;',
    '    }',
    '    emit({ id: request.id, result: { turn: { id: "ordinary-turn" } } });',
    '    complete("ordinary-turn");',
    '    return;',
    '  }',
    '  if (request.method === "turn/interrupt") {',
    '    const file = path.join(root, "interrupts.log");',
    '    fs.appendFileSync(file, request.params.turnId + "\\n");',
    '    const count = fs.readFileSync(file, "utf8").trim().split("\\n").length;',
    '    emit({ id: request.id, result: {} });',
    '    if (count === 1) setTimeout(() => emit({ method: "turn/started", params: { threadId: "round7-thread", turn: { id: "late-turn" } } }), 25);',
    '    return;',
    '  }',
    '  if (request.id !== undefined) emit({ id: request.id, result: {} });',
    '});',
  ].join('\n'));
  await chmod(command, 0o700);
  return {
    root,
    cwd,
    command,
    requestsPath: path.join(cwd, 'requests.log'),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await check(), true, 'synthetic protocol did not reach the expected state');
}

async function requests(fixture: Fixture): Promise<Array<{ method?: string }>> {
  return (await readFile(fixture.requestsPath, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method?: string });
}

async function assertFixtureProcessExited(fixture: Fixture): Promise<void> {
  const pidText = await readFile(path.join(fixture.cwd, 'server.pid'), 'utf8').catch(() => '');
  if (!pidText) return;
  let alive = false;
  try { process.kill(Number(pidText), 0); alive = true; }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
  assert.equal(alive, false, 'synthetic child process must exit before cleanup returns');
}

function appOptions(fixture: Fixture, signal?: AbortSignal) {
  return {
    provider: 'codex' as const, cwd: fixture.cwd, model: 'fixture-model',
    storagePath: path.join(fixture.root, 'storage'), codexPath: fixture.command, backend: 'app-server' as const,
    ...(signal ? { signal } : {}),
  };
}

interface Fixture {
  root: string;
  cwd: string;
  command: string;
  requestsPath: string;
  cleanup(): Promise<void>;
}

test('App Server converts a string startup abort reason and disposes its child', async () => {
  const fixture = await makeFixture('app-server-string-startup', { holdInitialize: true });
  const controller = new AbortController();
  const opening = createCodexAppServerSession(appOptions(fixture, controller.signal));
  try {
    await waitFor(async () => (await requests(fixture)).some((request) => request.method === 'initialize'));
    controller.abort('synthetic startup reason');
    await assert.rejects(opening, /synthetic startup reason/);
    assert.equal((await requests(fixture)).some((request) => request.method === 'thread/start'), false);
    await assertFixtureProcessExited(fixture);
  } finally {
    await fixture.cleanup();
  }
});

test('App Server preserves saved command output, falls back to plan todos, and normalizes subagent state', async () => {
  const fixture = await makeFixture('app-server-round7-state');
  const session = await createCodexAppServerSession(appOptions(fixture));
  const background: AgentUpdate[] = [];
  const live: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    await session.run('saved-output', new AbortController().signal, (update) => live.push(update));
    const savedOutput = background.filter((update) => update.id === 'saved-command').at(-1);
    assert.equal(savedOutput?.text, 'echo saved\nretained output');
    assert.equal(savedOutput?.tool?.status, 'running');

    await session.run('todo-plan', new AbortController().signal, (update) => live.push(update));
    assert.deepEqual(live.find((update) => update.id === 'plan-todos')?.meta?.todos, [
      { content: 'fallback plan step', status: 'completed' },
    ]);

    await session.run('subagent-fallback', new AbortController().signal, (update) => live.push(update));
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-status' && update.meta.subagent.status === 'unknown' && update.meta.subagent.resultPreview === 'child result'), true);
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'grandchild-status' && update.meta.subagent.status === 'running'), true);
  } finally {
    unsubscribe();
    await session.dispose();
    await assertFixtureProcessExited(fixture);
    await fixture.cleanup();
  }
});

test('App Server accepts a start response without a turn id and disposes an active waiter safely', async () => {
  const noIdFixture = await makeFixture('app-server-empty-turn-id');
  const noIdSession = await createCodexAppServerSession(appOptions(noIdFixture));
  try {
    await noIdSession.run('empty-id', new AbortController().signal, () => {});
    assert.equal(noIdSession.latestBackendTurnId?.(), undefined);
  } finally {
    await noIdSession.dispose();
    await assertFixtureProcessExited(noIdFixture);
    await noIdFixture.cleanup();
  }

  const pendingFixture = await makeFixture('app-server-dispose-waiter');
  const pendingSession = await createCodexAppServerSession(appOptions(pendingFixture));
  const pending = pendingSession.run('pending-dispose', new AbortController().signal, () => {});
  const pendingRejected = assert.rejects(pending, /Agent process closed/);
  try {
    await waitFor(() => pendingSession.latestBackendTurnId?.() === 'pending-dispose-turn');
    await pendingSession.dispose();
    await pendingRejected;
    await assertFixtureProcessExited(pendingFixture);
  } finally {
    await pendingFixture.cleanup();
  }
});

test('App Server interrupts a late started-turn notification after the active wait is aborted', async () => {
  const fixture = await makeFixture('app-server-late-interrupt');
  const session = await createCodexAppServerSession(appOptions(fixture));
  try {
    const controller = new AbortController();
    const pending = session.run('late-abort', controller.signal, () => {});
    await waitFor(() => session.latestBackendTurnId?.() === 'late-turn');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await waitFor(async () => {
      const text = await readFile(path.join(fixture.cwd, 'interrupts.log'), 'utf8').catch(() => '');
      return text.trim().split('\n').filter(Boolean).length === 2;
    });
    assert.deepEqual((await readFile(path.join(fixture.cwd, 'interrupts.log'), 'utf8')).trim().split('\n'), ['late-turn', 'late-turn']);
  } finally {
    await session.dispose();
    await assertFixtureProcessExited(fixture);
    await fixture.cleanup();
  }
});
