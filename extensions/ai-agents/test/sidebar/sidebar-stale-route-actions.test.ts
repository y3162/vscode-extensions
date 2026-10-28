import assert from 'node:assert/strict';

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, env, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('stale conversation actions are dropped and a terminal that disappeared cannot be opened', async () => {
  resetVscode();
  let factoryCalls = 0;
  const harness = withSession(async () => {
    factoryCalls += 1;
    return {
      sessionId: 'terminal-disappeared',
      async run() {},
      async listBackgroundTerminals() { return []; },
      async dispose() {},
    };
  });
  try {
    await harness.sidebar.handleMessage({ type: 'send', conversationId: 'already-closed-conversation', provider: 'codex', cwd: harness.workspacePath, prompt: 'must not send' });
    assert.equal(factoryCalls, 0);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'create current session' });
    await harness.sidebar.handleMessage({ type: 'openTerminal', processId: 42 });
    await assert.rejects(harness.sidebar.handleMessage({ type: 'openTerminal', processId: 'ended-process' }), /終了しています/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'must not send'), false);
    assert.equal(factoryCalls, 1);
  } finally {
    await close(harness);
  }
});
