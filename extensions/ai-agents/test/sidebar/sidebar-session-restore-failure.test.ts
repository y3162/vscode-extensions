import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('restore backend failure leaves an error state and logs the failure without claiming a live session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'round10-unavailable-resume', title: 'Synthetic saved session', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'sdk', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const output = window.createOutputChannel('AI Agents');
  const optionsSeen: SessionOptions[] = [];
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions): Promise<AgentSession> => {
    optionsSeen.push(options);
    throw new Error('synthetic backend unavailable');
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const view = createView();
  try {
    sidebar.resolveWebviewView(view as never);
    await sidebar.handleMessage({ type: 'ready' }, view as never);
    view.receive({ type: 'restoreSession', id: summary.id });
    await waitFor(() => sidebar.controller.snapshot().messages.some((message) => message.role === 'error' && message.text.includes('synthetic backend unavailable')), 'restore failure state');

    const state = sidebar.controller.snapshot();
    assert.equal(optionsSeen.length, 1);
    assert.equal(optionsSeen[0]?.resumeId, summary.id);
    assert.equal(sidebar.controller.hasSession(), false);
    assert.equal(state.status, 'error');
    assert.match(state.messages.find((message) => message.role === 'error')?.text ?? '', /synthetic backend unavailable/);
    assert.ok(output.lines.some((line) => line.includes('synthetic backend unavailable')));
    await waitFor(() => view.messages.some((message) => message.type === 'state' && JSON.stringify(message.messages).includes('synthetic backend unavailable')), 'restore error rendered in the webview');
    assert.equal(window.errorMessages.length, 0, 'the controller preserves the failure as visible session state and logs it once');
  } finally {
    await close(harness);
  }
});
