import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, env, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

function session(id: string): AgentSession {
  return {
    sessionId: id,
    async run(prompt, _signal, emit) {
      emit({ id: `${id}-answer`, role: 'assistant', text: `answer to ${prompt}`, final: true });
    },
    async dispose() {},
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('rewind confirmation summarizes long prompts and more than eight files in both locales', async () => {
  for (const locale of ['en', 'ja'] as const) {
    resetVscode();
    env.language = locale;
    const harness = withSession(async () => session(`rewind-copy-${locale}`));
    try {
      await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed prompt' });
      const turnId = harness.sidebar.controller.snapshot().turns[0]?.id;
      assert.ok(turnId);
      harness.sidebar.controller.previewRewind = async () => ({
        targetId: turnId,
        prompt: 'o'.repeat(181),
        removedTurns: 3,
        files: Array.from({ length: 10 }, (_value, index) => `file-${index}.txt`),
      });

      const edited = 'e'.repeat(181);
      await harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: edited });
      const body = window.warningMessages.at(-1) ?? '';

      assert.ok(body.includes('o'.repeat(180) + '…'));
      assert.ok(body.includes('e'.repeat(180) + '…'));
      assert.match(body, /10/);
      assert.ok(body.includes(['file-0.txt', 'file-1.txt', 'file-2.txt', 'file-3.txt', 'file-4.txt', 'file-5.txt', 'file-6.txt', 'file-7.txt'].join(', ')));
      assert.ok(body.includes(locale === 'ja' ? '、ほか' : ', and more'));
      assert.ok(body.includes(locale === 'ja' ? '後続ターン 2 件' : '2 later turn(s)'));
      assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed prompt'), true);
      assert.equal(harness.sidebar.controller.snapshot().busy, false);
    } finally {
      await close(harness);
    }
  }
});
