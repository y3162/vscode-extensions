import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions as ProviderSessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('restoreSession uses the active workspace when a saved index entry has no cwd', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'legacy-session-without-cwd', title: 'Older session', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'sdk',
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: ProviderSessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: ProviderSessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });

    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.cwd, paths.workspacePath);
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.snapshot().selection.cwd, paths.workspacePath);
    assert.equal(sidebar.controller.sessionId(), summary.id);
  } finally {
    await close(harness);
  }
});
