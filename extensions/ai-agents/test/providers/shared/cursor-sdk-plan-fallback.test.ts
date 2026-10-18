import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { createSession } from '../../../src/providers/index.js';

import type { AgentUpdate } from '../../../src/types.js';

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ai-agents-provider-index-final-'));
}

test('Cursor uses an empty plan fallback for a missing result and ignores malformed saved message bodies', async () => {
  const cwd = await tempDirectory();
  const agent = {
    agentId: 'missing-result-agent',
    async send() {
      return {
        id: 'empty-plan-run', status: 'finished',
        async *stream() {},
        async wait() { return { id: 'empty-plan-run', status: 'finished' }; },
        async cancel() {},
      };
    },
    async [Symbol.asyncDispose]() {},
  };
  const sdk = {
    Agent: {
      async create() { return agent; },
      async resume() { return agent; },
      async listRuns() { return { items: [], nextCursor: undefined }; },
      messages: {
        async list() {
          return [
            { uuid: 'missing-body', type: 'user', message: null },
            { uuid: 'wrong-body', type: 'assistant', message: 'plain text' },
            { uuid: 'no-content', type: 'assistant', message: { text: 'not a content array' } },
            { uuid: 'valid-body', type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } },
          ];
        },
      },
    },
    Cursor: { auth: { async status() { return { status: 'logged-in' }; } } },
    JsonlLocalAgentStore: class { constructor(_root: string) {} },
  };
  const loaders = {
    codex: async () => { throw new Error('Codex is not selected'); },
    cursor: async () => sdk as never,
  };
  const session = await createSession({
    provider: 'cursor', cwd, model: '', storagePath: path.join(cwd, 'store'), apiKey: 'synthetic-key',
  }, loaders, true);
  try {
    const updates: AgentUpdate[] = [];
    await session.run!('empty plan', new AbortController().signal, (update) => updates.push(update), undefined, {
      intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: '' },
    });
    assert.equal(updates.some((update) => update.id === 'plan-text' || update.id === 'result'), false);

    const messages: Array<{ id: string; role: string; text: string }> = [];
    await session.loadTranscript!((message) => messages.push({ id: message.id, role: message.role, text: message.text }));
    assert.deepEqual(messages, [{ id: 'valid-body', role: 'assistant', text: 'kept' }]);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
