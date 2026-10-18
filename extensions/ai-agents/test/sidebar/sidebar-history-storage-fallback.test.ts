import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, Selection, SessionSummary } from '../../src/types.js';

import { commands, env, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

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

test('history uses global storage when the workspace storage URI is unavailable', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  Object.defineProperty(paths.context, 'storageUri', { value: undefined });
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, async () => session('global-storage-fallback'));
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'save through global storage' });
    const history = path.join(paths.context.globalStorageUri.fsPath, 'history', 'v1');
    await waitFor(() => existsSync(history) && readdirSync(history).some((name) => name.endsWith('.json')), 'global storage history snapshot');
    assert.equal(readdirSync(path.join(paths.root, 'storage')).some((name) => name === 'history'), false);
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.text === 'save through global storage'), true);
  } finally {
    await close(harness);
  }
});
