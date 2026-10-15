import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCursorAcpSession } from '../src/providers/cursor-acp.js';

test('a missing Cursor CLI fails once and names the ACP command', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-missing-cli-'));
  try {
    await assert.rejects(() => createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, backend: 'acp',
      agentPath: path.join(cwd, 'missing-agent'),
    }), /Cursor CLI/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('an authentication failure from Cursor ACP is shown and does not retry', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-auth-fail-'));
  const command = path.join(cwd, 'auth-fail.cjs');
  await writeFile(command, `#!/usr/bin/env node
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }] } });
  else if (request.method === 'authenticate') emit({ id: request.id, error: { code: -32000, message: 'login required' } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
`);
  try {
    await assert.rejects(() => createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, backend: 'acp', agentPath: command,
    }), /agent login/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
