import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, SendExtras } from '../../src/types.js';

import { extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round16-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round16-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  }));
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, sessionFactory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('background cap falls back from blank image-only prompt to session ID or running label', async () => {
  for (const sessionId of ['round16-image-only-session', ''] as const) {
    resetVscode();
    workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = withSession(async () => ({
      sessionId,
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        entered();
        await gate;
        emit({ id: 'round16-image-final', role: 'assistant', text: 'done', final: true });
      },
      async dispose() {},
    }));
    let sending: Promise<void> | undefined;
    try {
      sending = harness.sidebar.handleMessage({
        type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '',
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      });
      await started;
      const active = harness.sidebar.controller;
      const user = active.snapshot().messages.find((message) => message.role === 'user');
      assert.equal(user?.text, '', 'image-only turns can have no user-visible text title');
      await harness.sidebar.handleMessage({ type: 'newChat' });

      await assert.rejects(
        harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
        sessionId ? /round16-image-only-session/ : /running/,
      );
      assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
      assert.equal(active.snapshot().busy, true);
    } finally {
      release();
      await sending?.catch(() => undefined);
      await close(harness);
    }
  }
});
