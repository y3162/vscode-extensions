import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChatController } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, Selection, UsageStats } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'initial' };

test('rewind refuses a completed local turn with no backend turn identity before forking', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-missing-backend-id-'));
  let forks = 0;
  const controller = new ChatController({ ...selection, cwd }, async () => ({
    sessionId: 'missing-backend-turn',
    async run() {},
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn() { forks += 1; return 'must-not-fork'; },
    async dispose() {},
  }), () => {}, {
    journalDirectory: path.join(cwd, 'journals'), conversationId: () => 'conversation', enabled: () => true, async flush() {},
  });

  try {
    await controller.send('local turn without backend id');
    await assert.rejects(controller.previewRewind(controller.snapshot().turns[0]!.id), /Backend turn ID/);
    assert.equal(forks, 0);
    assert.equal(controller.snapshot().turns[0]?.status, 'completed');
    assert.equal(controller.snapshot().busy, false);
  } finally {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
