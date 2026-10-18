import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

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

test('restoring an indexed conversation without a backend safely handles picker cancel and resumes after selection', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'historical-app-server-thread',
    title: 'Historical conversation',
    updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex',
    cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  let factoryCalls = 0;
  let optionsSeen: SessionOptions | undefined;
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions) => {
    factoryCalls += 1;
    optionsSeen = options;
    return session(summary.id);
  }) as never);
  const harness = { ...paths, sidebar, output };
  try {
    window.quickPickQueue.push(undefined);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.deepEqual(window.quickPickOffers.at(-1), ['sdk', 'app-server']);
    assert.equal(factoryCalls, 0, 'cancel must not construct or resume a backend session');
    assert.equal(sidebar.controller.sessionId(), undefined);

    window.quickPickQueue.push('app-server');
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(factoryCalls, 1);
    assert.equal(optionsSeen?.backend, 'app-server');
    assert.equal(optionsSeen?.resumeId, summary.id);
    assert.equal(sidebar.controller.sessionId(), summary.id);
    assert.equal(sidebar.controller.snapshot().selection.cwd, paths.workspacePath);
  } finally {
    await close(harness);
  }
});
