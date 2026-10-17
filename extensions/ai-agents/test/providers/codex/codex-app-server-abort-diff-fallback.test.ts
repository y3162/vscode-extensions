import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate } from '../../../src/types.js';

const server = `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'synthetic-thread', historyMode: 'paginated' } } });
  else if (request.method === 'turn/start') {
    const turnId = request.params.input[0].text === 'diff-only' ? 'diff-turn' : 'abort-turn';
    emit({ method: 'turn/started', params: { threadId: 'synthetic-thread', turn: { id: turnId } } });
    if (turnId === 'diff-turn') {
      emit({ method: 'turn/diff/updated', params: { threadId: 'synthetic-thread', turn: { id: turnId }, diff: 'diff --git a/src/recovered.txt b/src/recovered.txt\\n--- a/src/recovered.txt\\n+++ b/src/recovered.txt\\n@@ -0,0 +1 @@\\n+recovered\\n' } });
      emit({ method: 'turn/completed', params: { threadId: 'synthetic-thread', turn: { id: turnId, status: 'completed' } } });
    }
    emit({ id: request.id, result: { turn: { id: turnId } } });
  } else if (request.method === 'turn/interrupt') {
    fs.appendFileSync(path.join(process.cwd(), 'interrupts.log'), request.params.turnId + '\\n');
    emit({ id: request.id, result: {} });
  } else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [] } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`;

async function makeSession() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-server-abort-diff-'));
  const command = path.join(cwd, 'synthetic-app-server.cjs');
  await writeFile(command, server);
  await chmod(command, 0o755);
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, storagePath: cwd, model: 'fixture', codexPath: command,
  });
  return { cwd, session, async cleanup() {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  } };
}

function abortAtRead(target: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() { return ++reads >= target; },
    get reason() { return new DOMException('Cancelled at the response boundary', 'AbortError'); },
    onabort: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    throwIfAborted() {
      if (reads >= target) throw new DOMException('Cancelled at the response boundary', 'AbortError');
    },
  } as unknown as AbortSignal;
}

async function assertInterrupted(cwd: string, expectedTurnId: string): Promise<void> {
  const logged = await readFile(path.join(cwd, 'interrupts.log'), 'utf8');
  assert.deepEqual(logged.trim().split('\n'), [expectedTurnId]);
}

test('Codex App Server emits unfiltered turn diff when no file item announced paths', async () => {
  const { session, cleanup } = await makeSession();
  const updates: AgentUpdate[] = [];
  try {
    await session.run('diff-only', new AbortController().signal, (update) => updates.push(update));
    const diff = updates.find((update) => update.id === 'diff-turn:diff');
    assert.equal(diff?.meta?.files?.length, 1);
    assert.equal(diff?.meta?.files?.[0]?.path, 'src/recovered.txt');
    assert.equal(diff?.meta?.files?.[0]?.additions, 1);
    assert.equal(diff?.meta?.files?.[0]?.deletions, 0);
  } finally {
    await cleanup();
  }
});

test('Codex App Server interrupts if cancellation arrives before waiting for the started turn', async () => {
  const { cwd, session, cleanup } = await makeSession();
  try {
    await assert.rejects(session.run('abort', abortAtRead(3), () => {}), { name: 'AbortError' });
    await assertInterrupted(cwd, 'abort-turn');
  } finally {
    await cleanup();
  }
});

test('Codex App Server interrupts if cancellation is observed at the wait-turn boundary', async () => {
  const { cwd, session, cleanup } = await makeSession();
  try {
    await assert.rejects(session.run('abort', abortAtRead(4), () => {}), { name: 'AbortError' });
    await assertInterrupted(cwd, 'abort-turn');
  } finally {
    await cleanup();
  }
});
