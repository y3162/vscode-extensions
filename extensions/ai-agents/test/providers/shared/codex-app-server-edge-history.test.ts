import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate, ChatMessage } from '../../../src/types.js';

const fixture = path.resolve('test/fixtures/mock-app-server.cjs');

test('App Server replays parent errors, file changes and paginated child history', async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-edge-history-');
  const session = await createCodexAppServerSession({ provider: 'codex', backend: 'app-server', cwd,
    storagePath: cwd, model: 'fixture', codexPath: fixture, resumeId: 'thread-edge-history' });
  try {
    const messages: ChatMessage[] = [];
    await session.loadTranscript?.((message) => messages.push(message));
    assert.ok(messages.some((message) => message.role === 'error' && message.text === 'parent failed'));
    assert.ok(messages.some((message) => message.id === 'parent-edge:command-edge' && message.text === 'echo edge\nstdout'));
    assert.ok(messages.some((message) => message.meta?.type === 'files' && message.meta.files?.[0]?.path === 'edge.txt'));
    assert.ok(messages.some((message) => message.meta?.type === 'thinking' && message.text === 'reasoning'));
    assert.ok(messages.some((message) => message.subagentId === 'child-edge' && message.text === 'edge child answer'));
    assert.ok(messages.some((message) => message.meta?.subagent?.id === 'child-no-history'));
    assert.ok(messages.some((message) => message.meta?.subagent?.id === 'child-no-parent'));
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('App Server bounds child output and preserves wait and command progress', async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-edge-live-');
  const session = await createCodexAppServerSession({ provider: 'codex', backend: 'app-server', cwd,
    storagePath: cwd, model: 'fixture', codexPath: fixture });
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates?.((update) => updates.push(update));
  try {
    await session.run('EDGE_NOTIFICATIONS', new AbortController().signal, (update) => updates.push(update));
    assert.ok(updates.some((update) => update.subagentId === 'edge-live-child' && update.id === 'child-command-edge'));
    assert.ok(updates.some((update) => update.subagentId === 'edge-live-child' && update.id === 'child-wait-edge'));
    assert.ok(updates.some((update) => update.id === 'subagent-wait:wait-edge-live' && update.meta?.subagentWait?.waiting === false));
    assert.ok(updates.some((update) => update.subagentId === 'edge-live-child' && update.text.endsWith('[Earlier output omitted]')));
  } finally {
    unsubscribe?.();
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
