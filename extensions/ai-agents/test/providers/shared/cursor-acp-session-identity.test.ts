import assert from 'node:assert/strict';

import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createCursorAcpSession } from '../../../src/providers/cursor-acp.js';

test('Cursor ACP publishes the identity of a newly created session', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-acp-identity-'));
  const command = path.join(cwd, 'mock-acp.cjs');
  await cp(path.join(__dirname, '../../fixtures', 'mock-acp.cjs'), command);
  await cp(path.join(__dirname, '../../fixtures', 'synthetic-runtime.cjs'), path.join(cwd, 'synthetic-runtime.cjs'));
  await chmod(command, 0o755);
  let identity: import('../../../src/types.js').SessionSummary | undefined;
  let session: Awaited<ReturnType<typeof createCursorAcpSession>> | undefined;
  try {
    session = await createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command,
      onIdentity(value) { identity = value; },
    });
    assert.ok(identity);
    assert.equal(identity.id, 'acp-session');
    assert.equal(identity.title, 'Cursor ACP');
    assert.equal(identity.provider, 'cursor');
    assert.equal(identity.cwd, cwd);
    assert.ok(Number.isFinite(Date.parse(identity.updatedAt)));
    assert.ok(Date.parse(identity.updatedAt) <= Date.now());
    assert.equal(session.sessionId, 'acp-session');
  } finally {
    await session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
