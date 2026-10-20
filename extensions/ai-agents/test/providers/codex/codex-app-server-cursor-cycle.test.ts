import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';

test('App Server stops terminal output reconciliation when a history cursor repeats', async () => {
  for (const phase of ['history', 'turn'] as const) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-cursor-'));
    const command = path.join(cwd, 'synthetic-app-server.cjs');
    await writeFile(command, `#!/usr/bin/env node
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/resume') emit({ id: request.id, result: { thread: { id: 'cursor-thread' } } });
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [{ processId: 'cursor-process', itemId: 'cursor-item' }] } });
  else if (request.method === 'thread/items/list') {
    const phase = ${JSON.stringify(phase)};
    if (phase === 'turn' && !request.params.turnId) emit({ id: request.id, result: { data: [{ turnId: 'cursor-turn', item: { id: 'cursor-item', type: 'commandExecution' } }] } });
    else emit({ id: request.id, result: { data: [], nextCursor: 'repeat' } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
    await chmod(command, 0o700);
    const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd,
      codexPath: command, backend: 'app-server', resumeId: 'cursor-thread' });
    try {
      const terminals = await session.listBackgroundTerminals?.();
      assert.match(terminals?.[0]?.outputError ?? '', /repeated an item (history|turn) cursor/);
    } finally {
      await session.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
