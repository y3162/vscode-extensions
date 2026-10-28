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

test('restoring an unknown session does not prompt or assume a CLI origin', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'historical-app-server-thread',
    title: 'Historical conversation',
    updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex',
    cwd: paths.workspacePath,
  };
  let factoryCalls = 0;
  let optionsSeen: SessionOptions | undefined;
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, (async (options: SessionOptions) => {
    factoryCalls += 1;
    optionsSeen = options;
    return session(summary.id);
  }) as never);
  const harness = { ...paths, sidebar, output };
  try {
    sidebar.controller.replaceSessions([summary]);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(window.quickPickOffers.length, 0);
    assert.equal(factoryCalls, 0);
    assert.equal(sidebar.controller.sessionId(), undefined);
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('確認できない')));
  } finally {
    await close(harness);
  }
});
