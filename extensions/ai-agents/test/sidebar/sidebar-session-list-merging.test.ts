import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, ImageAttachment, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('refreshSessions merges Cursor SDK, live backend, and persisted summaries through the webview route', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const persisted: SessionSummary = {
    id: 'persisted-cursor-session', title: 'Persisted', updatedAt: '2026-10-17T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const sdk: SessionSummary = {
    id: 'sdk-cursor-session', title: 'SDK store', titleSource: 'provider', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const unnamed: SessionSummary = {
    id: 'unnamed-cursor-session', title: 'New Agent', titleSource: 'provider', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const live: SessionSummary = {
    id: 'live-cursor-session', title: 'Live backend', updatedAt: '2026-10-19T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [persisted, { ...sdk, title: 'First prompt', titleSource: 'local' }, { ...unnamed, title: 'Visible first prompt', titleSource: 'local' }]);
  let listerOptions: { cwd: string; storagePath: string } | undefined;
  const sidebar = new AgentsSidebar(
    paths.context as never,
    output as never,
    (async (options: Pick<SessionOptions, 'cwd' | 'storagePath' | 'apiKey'>) => { listerOptions = options; return [sdk, unnamed]; }) as never,
    (async (_options: SessionOptions) => ({
      sessionId: 'cursor-current-session',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) { emit({ id: 'cursor-current-answer', role: 'assistant', text: 'done', final: true }); },
      async listSessions() { return [live]; },
      async dispose() {},
    })) as never,
  );
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: paths.workspacePath, prompt: 'open the current session' });
    await sidebar.handleMessage({ type: 'refreshSessions' });

    assert.equal(listerOptions?.cwd, paths.workspacePath);
    assert.ok(listerOptions?.storagePath.endsWith('cursor-agents'));
    const ids = sidebar.controller.snapshot().sessions.map((item) => item.id);
    assert.ok(ids.includes(persisted.id));
    assert.ok(ids.includes(sdk.id));
    assert.ok(ids.includes(live.id));
    assert.deepEqual(paths.context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex')?.map((item) => item.id), ids);
    const listed = sidebar.controller.snapshot().sessions.find((item) => item.id === sdk.id);
    assert.equal(listed?.title, 'SDK store');
    assert.equal(listed?.titleSource, 'provider');
    assert.equal(sidebar.controller.snapshot().sessions.find((item) => item.id === unnamed.id)?.title, 'Visible first prompt');
  } finally {
    await close(harness);
  }
});
