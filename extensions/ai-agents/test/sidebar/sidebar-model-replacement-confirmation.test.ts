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

test('Japanese model replacement preserves the active CLI conversation', async () => {
  resetVscode();
  env.language = 'ja';
  const harness = withSession(async () => session('cli-model-session'));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep this conversation' });
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this conversation'));
    harness.sidebar.listAvailableModels = async () => [{ id: 'replacement-model', label: 'Replacement model' }];

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'replacement-model' });
    assert.equal(window.warningMessages.length, 0);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'replacement-model');
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this conversation'));
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex?.model, 'replacement-model');
  } finally {
    await close(harness);
  }
});
