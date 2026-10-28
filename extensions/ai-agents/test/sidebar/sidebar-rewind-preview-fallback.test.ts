import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, Selection, SessionSummary } from '../../src/types.js';

import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round10-late-session',
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

test('English rewind confirmation covers an unchanged preview and omits absent saved media', async () => {
  resetVscode();
  const harness = withSession();
  const sent: Array<{ id: string; prompt: string; extras: unknown }> = [];
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'stable turn' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(id: string, prompt: string, extras: unknown): Promise<void>;
    };
    const turn = harness.sidebar.controller.snapshot().turns[0]!;
    controller.retryInput = () => ({ prompt: 'stable turn' });
    controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'stable turn', removedTurns: 1, files: [] });
    controller.rewindAndSend = async (id, prompt, extras) => { sent.push({ id, prompt, extras }); };
    window.warningQueue.push({ value: 'Rewind and resend' });

    await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: '  replacement  ' });

    assert.match(window.warningMessages.at(-1) ?? '', /Edit this prompt in place/);
    assert.match(window.warningMessages.at(-1) ?? '', /No file changes need restoring/);
    assert.deepEqual(sent, [{ id: turn.id, prompt: 'replacement', extras: { displayText: 'replacement' } }]);
  } finally {
    await close(harness);
  }
});
