import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

function trackedSession(id: string, runs: string[], onCreate?: (options: SessionOptions) => void): (options: SessionOptions) => Promise<AgentSession> {
  return async (options) => {
    onCreate?.(options);
    return {
      sessionId: id,
      async run(prompt, _signal, emit) {
        runs.push(prompt);
        emit({ id: `${id}-answer-${runs.length}`, role: 'assistant', text: `answer: ${prompt}`, final: true });
      },
      async dispose() {},
    };
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('restoreSession ignores unknown IDs and the current session without constructing duplicates', async () => {
  resetVscode();
  const runs: string[] = [];
  let factoryCalls = 0;
  let summary: SessionSummary | undefined;
  const harness = withFactory(trackedSession('restore-known-session', runs, (options) => {
    factoryCalls += 1;
    options.onIdentity?.({
      id: 'restore-known-session', title: 'Known session', updatedAt: new Date().toISOString(),
      provider: 'codex', cwd: harness.workspacePath,
    });
  }));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'saved session' });
    const controller = harness.sidebar.controller;
    const initialMessages = controller.snapshot().messages;
    const initialId = controller.sessionId();
    summary = controller.snapshot().sessions.find((item) => item.id === initialId);
    assert.ok(summary);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: 'unknown-session-id' });
    assert.equal(harness.sidebar.controller, controller);
    assert.equal(factoryCalls, 1);

    await harness.sidebar.handleMessage({ type: 'restoreSession', id: initialId });
    assert.equal(harness.sidebar.controller, controller);
    assert.equal(controller.sessionId(), initialId);
    assert.deepEqual(controller.snapshot().messages, initialMessages);
    assert.equal(factoryCalls, 1);
    assert.ok(summary);
  } finally {
    await close(harness);
  }
});
