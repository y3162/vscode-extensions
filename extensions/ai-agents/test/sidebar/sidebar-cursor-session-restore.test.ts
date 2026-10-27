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

test('Cursor restore offers its backend choices and cancellation does not create a resumed session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'cursor-indexed-thread', title: 'Cursor history', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: paths.workspacePath });
    window.quickPickQueue.push(undefined);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.deepEqual(window.quickPickOffers.at(-1), ['sdk', 'acp', 'cli']);
    assert.equal(optionsSeen.length, 0);
    assert.equal(sidebar.controller.sessionId(), undefined);

    window.quickPickQueue.push('acp');
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.backend, 'acp');
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});
