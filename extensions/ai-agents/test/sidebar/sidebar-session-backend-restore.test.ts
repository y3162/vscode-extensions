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

test('saved CLI session resumes without a picker and ignores backend changes', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'saved-app-server-session', title: 'Saved app-server conversation', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'cli', cwd: paths.workspacePath,
  };
  const options: Array<{ backend?: string; resumeId?: string }> = [];
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (value: { backend?: string; resumeId?: string }): Promise<AgentSession> => {
    options.push(value);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    sidebar.controller.replaceSessions([summary]);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(options.length, 1);
    assert.equal(options[0]?.backend, 'cli');
    assert.equal(options[0]?.resumeId, summary.id);
    assert.equal(window.quickPickOffers.length, 0, 'a saved backend avoids asking the user to choose it again');
    assert.equal(sidebar.controller.hasSession(), true);

    await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
    const controls = paths.context.workspaceState.get<Record<string, { backend: string }>>('ai-agents.controls');
    assert.equal(controls?.codex?.backend, 'cli');
    assert.equal(sidebar.controller.hasSession(), true);
  } finally {
    await close(harness);
  }
});

test('old settings use CLI while a non-CLI saved session remains untouched', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'legacy-sdk-session', title: 'Old conversation', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'sdk', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.controls', {
    codex: { backend: 'sdk', mode: 'agent', sandbox: 'workspace-write', approval: 'never', network: false, webSearch: '', additionalDirectories: [] },
  });
  const seen: Array<{ backend?: string }> = [];
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: { backend?: string }) => {
    seen.push(options);
    return { sessionId: 'new-cli-session', async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    sidebar.controller.replaceSessions([summary]);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(seen.length, 0);
    assert.equal(window.quickPickOffers.length, 0);
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('確認できない')));
    assert.equal(sidebar.controller.snapshot().sessions.some((item) => item.id === summary.id && item.backend === 'sdk'), true);
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'new CLI conversation' });
    assert.equal(seen[0]?.backend, 'cli');
  } finally {
    await close(harness);
  }
});
