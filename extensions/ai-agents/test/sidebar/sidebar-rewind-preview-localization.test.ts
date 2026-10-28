import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round12-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round12-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
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

test('rewind previews show up to eight file names without the overflow marker in both locales', async () => {
  for (const scenario of [
    { locale: 'en-US', files: ['one.txt'], expected: 'Files to restore (1): one.txt', omitted: ', and more' },
    { locale: 'ja-JP', files: Array.from({ length: 8 }, (_value, index) => `file-${index}.txt`), expected: '復元するファイル (8): file-0.txt', omitted: '、ほか' },
  ]) {
    resetVscode();
    env.language = scenario.locale;
    const harness = withSession();
    try {
      await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed rewind preview' });
      const controller = harness.sidebar.controller as unknown as {
        previewRewind(id: string): Promise<{ targetId: string; prompt: string; removedTurns: number; files: string[] }>;
      };
      const turn = harness.sidebar.controller.snapshot().turns[0]!;
      controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'short prompt', removedTurns: 1, files: scenario.files });
      window.warningQueue.push({ value: undefined });

      await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'replacement' });

      const prompt = window.warningMessages.at(-1) ?? '';
      assert.ok(prompt.includes(scenario.expected));
      assert.equal(prompt.includes(scenario.omitted), false, 'the overflow marker is reserved for previews with more than eight files');
      assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed rewind preview'), true,
        'cancelling the confirmation leaves the original conversation visible');
    } finally {
      await close(harness);
    }
  }
});
