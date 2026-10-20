import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ChatController } from '../../src/chat-controller.js';
import { createManagedSession } from '../../src/providers/managed-session.js';
import type { AgentSession, Selection } from '../../src/types.js';

for (const intent of ['chat', 'plan', 'build'] as const) test(`controller restores retained ${intent} without resending or double Usage`, { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await mkdtemp('/private/tmp/ai-agents-controller-managed-');
  const selection: Selection = { provider: 'codex', cwd, model: 'gpt-6-luna' };
  let session: AgentSession | undefined;
  const factory = async (_selection: Selection, context?: { resumeId?: string }) => session = await createManagedSession({
    ...selection, backend: 'app-server', storagePath: cwd, ownerKey: 'isolated-controller',
    codexPath: path.resolve('test/fixtures/mock-app-server.cjs'), resumeId: context?.resumeId,
  });
  let first = new ChatController(selection, factory, () => undefined);
  let second: ChatController | undefined;
  try {
    if (intent === 'build') {
      const state = first.snapshot();
      state.plan = { phase: 'ready', revisions: [], current: { id: 'stable-plan', revision: 2, markdown: 'Execute the retained build.', todos: [], source: 'assistant-text', createdAt: Date.now(), sessionId: 'thread-1' }, build: { selection } };
      first.restoreSnapshot(state, 'thread-1');
    }
    const sending = first.send('MANAGED_RELOAD_GATE', undefined, { intent, mode: intent === 'plan' ? 'plan' : 'agent', selection });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await readFile(path.join(cwd, 'managed-dispatches.txt')).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const saved = first.snapshot();
    assert.equal(saved.turns.at(-1)?.status, 'running');
    await first.dispose(); // detach, without cancelling
    await sending;
    second = new ChatController(selection, factory, () => undefined);
    second.restoreSnapshot(saved, 'thread-1');
    await writeFile(path.join(cwd, 'managed-release'), 'release');
    await second.openSession();
    const state = second.snapshot();
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0]?.id, saved.turns[0]?.id);
    assert.equal(state.turns[0]?.status, 'completed');
    assert.equal(state.turns[0]?.backendTurnId, 'managed-held-turn');
    assert.equal(state.usage?.totalTokens, 14);
    if (intent === 'plan') { assert.equal(state.plan.phase, 'ready'); assert.equal(state.plan.current?.revision, 1); }
    if (intent === 'build') { assert.equal(state.plan.phase, 'implemented'); assert.equal(state.plan.current?.id, 'stable-plan'); assert.equal(state.plan.current?.revision, 2); }
    assert.equal(await readFile(path.join(cwd, 'managed-dispatches.txt'), 'utf8'), 'managed-held-turn\n');
  } finally { await session?.dispose(); await second?.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
