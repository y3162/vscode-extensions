import assert from 'node:assert/strict';

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

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
  const sidebar = new AgentsSidebar(paths.context as never, output as never, async () => session('global-storage-fallback'));
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'save through global storage' });
    await sidebar.flushHistory();
    const history = path.join(paths.context.globalStorageUri.fsPath, 'history', 'v1');
    assert.equal(existsSync(history) && readdirSync(history).some((name) => name.endsWith('.json')), false);
    const saved = readdirSync(path.join(history, 'conversations')).filter((name) => name.endsWith('.json'));
    assert.equal(saved.length, 1);
    assert.match(readFileSync(path.join(history, 'conversations', saved[0]!), 'utf8'), /save through global storage/);
    const workspaceHistory = path.join(paths.root, 'storage', 'history', 'v1');
    assert.equal(existsSync(workspaceHistory) && readdirSync(workspaceHistory).some((name) => name.endsWith('.json')), false);
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.text === 'save through global storage'), true);
  } finally {
    await close(harness);
  }
});
