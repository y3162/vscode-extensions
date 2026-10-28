import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round9-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  }));
  const sidebar = new AgentsSidebar(paths.context as never, output as never, sessionFactory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('rewind confirmation formats long previews and preserves saved image and attachment payloads', async () => {
  resetVscode();
  const harness = withSession();
  const captured: Array<{ id: string; text: string; extras: unknown }> = [];
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed rewind state' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(id: string, text: string, extras: unknown): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    const turn = state.turns[0]!;
    const user = state.messages.find((message) => message.role === 'user')!;
    turn.id = 'backend-local-turn';
    turn.userMessageId = user.id;
    turn.imageCount = 1;
    user.attachments = ['notes.md'];
    harness.sidebar.controller.restoreSnapshot(state);
    controller.retryInput = () => ({ prompt: 'original saved prompt', extras: {
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }], attachments: ['notes.md'],
    } });
    controller.previewRewind = async (id: string) => {
      assert.equal(id, user.id, 'lookup accepts the user message ID of a retry turn');
      return { targetId: turn.id, prompt: 'original '.repeat(30), removedTurns: 3, files: Array.from({ length: 9 }, (_, index) => `file-${index}.txt`) };
    };
    controller.rewindAndSend = async (id, text, extras) => { captured.push({ id, text, extras }); };
    window.warningQueue.push({ value: 'Rewind and resend' });
    const edited = 'replacement '.repeat(20);

    await harness.sidebar.handleMessage({ type: 'rewind', turnId: user.id, editedText: edited });

    const warning = window.warningMessages.at(-1) ?? '';
    assert.match(warning, /Original: original original/);
    assert.match(warning, /Replacement: replacement replacement/);
    assert.match(warning, /and 2 later turn\(s\)/);
    assert.match(warning, /file-0\.txt, file-1\.txt, file-2\.txt, file-3\.txt, file-4\.txt, file-5\.txt, file-6\.txt, file-7\.txt, and more/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.id, 'backend-local-turn');
    assert.equal(captured[0]?.text, edited.trim());
    assert.deepEqual(captured[0]?.extras, {
      displayText: edited.trim(),
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      attachments: ['notes.md'],
    });
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'replacement '.repeat(20).trim()), false,
      'the synthetic rewind seam captures the payload without starting an unintended second run');
  } finally {
    await close(harness);
  }
});
