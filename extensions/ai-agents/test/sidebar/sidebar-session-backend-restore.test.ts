import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, Selection, SessionSummary } from '../../src/types.js';

import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('saved session backend is reused without a picker and later settings changes reset the session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'saved-app-server-session', title: 'Saved app-server conversation', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'app-server', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const options: Array<{ backend?: string; resumeId?: string }> = [];
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (value: { backend?: string; resumeId?: string }): Promise<AgentSession> => {
    options.push(value);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(options.length, 1);
    assert.equal(options[0]?.backend, 'app-server');
    assert.equal(options[0]?.resumeId, summary.id);
    assert.equal(window.quickPickOffers.length, 0, 'a saved backend avoids asking the user to choose it again');
    assert.equal(sidebar.controller.hasSession(), true);

    await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
    const controls = paths.context.workspaceState.get<Record<string, { backend: string }>>('ai-agents.controls');
    assert.equal(controls?.codex?.backend, 'sdk');
    assert.equal(sidebar.controller.hasSession(), false, 'changing backend retires the session that was opened with the saved backend');
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('設定を変更')));
  } finally {
    await close(harness);
  }
});
