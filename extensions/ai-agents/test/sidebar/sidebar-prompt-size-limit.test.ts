import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

function openWithFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function session(id: string, onRun?: () => Promise<void>) {
  const models: Selection[] = [];
  const runs: string[] = [];
  const instance: AgentSession = {
    sessionId: id,
    async run(prompt, _signal, emit) {
      runs.push(prompt);
      await onRun?.();
      emit({ id: `${id}-answer-${runs.length}`, role: 'assistant', text: 'done', final: true });
    },
    async setModel(next) { models.push(next); },
    async dispose() {},
  };
  return { instance, models, runs };
}

test('the sidebar accepts a prompt exactly at its character limit', async () => {
  resetVscode();
  const live = session('maximum-prompt-session');
  const harness = openWithFactory(async () => live.instance);
  const prompt = 'x'.repeat(100_000);
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt });

    assert.deepEqual(live.runs, [prompt]);
    assert.equal(harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user')?.text.length, 100_000);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
  } finally {
    await close(harness);
  }
});
