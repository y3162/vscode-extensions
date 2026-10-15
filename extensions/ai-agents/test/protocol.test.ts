import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../src/providers/codex-app-server.js';
import { createCursorAcpSession } from '../src/providers/cursor-acp.js';
import type { AgentUpdate } from '../src/types.js';

async function fixture(name: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-protocol-'));
  const command = path.join(cwd, name);
  const { cp } = await import('node:fs/promises');
  await cp(path.join(__dirname, 'fixtures', name), command);
  await chmod(command, 0o755);
  return { cwd, command, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('Cursor ACP streams text, file diffs, and answers a permission request', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  try {
    let decision = '';
    const session = await createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command, backend: 'acp',
      interactions: {
        requestPermission: async (request) => { decision = request.title; return 'allow-once'; },
        requestPlan: async () => 'accepted',
        requestAnswers: async () => ({}),
      },
    });
    const updates: AgentUpdate[] = [];
    try {
      await session.run('NEED_PERMISSION', new AbortController().signal, (update) => updates.push(update));
      assert.equal(decision, 'npm test');
      assert.match(updates.map((update) => update.text).join('\n'), /permission:/);
      const files: AgentUpdate[] = [];
      await session.run('hello', new AbortController().signal, (update) => files.push(update));
      assert.match(files.map((update) => update.text).join('\n'), /acp answer/);
      assert.equal(files.some((update) => update.meta?.type === 'files'), true);
      const listed = await session.listSessions?.();
      assert.equal(listed?.[0]?.id, 'acp-session');
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});

test('Codex App Server streams deltas, lists threads, and returns an approval decision', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  try {
    let title = '';
    const session = await createCodexAppServerSession({
      provider: 'codex', cwd, model: 'fixture-model', storagePath: cwd, codexPath: command, backend: 'app-server',
      interactions: {
        requestPermission: async (request) => { title = request.title; return 'allow-once'; },
        requestPlan: async () => 'rejected',
        requestAnswers: async () => ({}),
      },
    });
    const updates: AgentUpdate[] = [];
    try {
      await session.run('hello app server', new AbortController().signal, (update) => updates.push(update));
      assert.match(updates.map((update) => update.text).join('\n'), /app server/);
      updates.length = 0;
      await session.run('NEED_APPROVAL', new AbortController().signal, (update) => updates.push(update));
      assert.equal(title, 'npm test');
      assert.match(updates.map((update) => update.text).join('\n'), /approved:accept/);
      assert.equal((await session.listSessions?.())?.[0]?.title, 'Fixture');
      assert.match(await session.rateLimits?.() ?? '', /12%/);
      assert.match(await session.instructions?.() ?? '', /fixture-skill/);
      assert.equal(await session.fork?.(), 'thread-2');
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});
