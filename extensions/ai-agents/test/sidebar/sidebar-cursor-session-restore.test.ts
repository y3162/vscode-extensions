import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor history without a known CLI origin does not open a picker or resume', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'cursor-indexed-thread', title: 'Cursor history', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: paths.workspacePath });
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(window.quickPickOffers.length, 0);
    assert.equal(optionsSeen.length, 0);
    assert.equal(sidebar.controller.sessionId(), undefined);
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('確認できない')));
  } finally {
    await close(harness);
  }
});
