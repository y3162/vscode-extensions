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
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a pending select cannot send into a conversation after newChat changes the front controller', async () => {
  resetVscode();
  const runs: string[] = [];
  let factoryCalls = 0;
  const harness = withFactory(async (options) => {
    factoryCalls += 1;
    return trackedSession(`race-session-${factoryCalls}`, runs)(options);
  });
  try {
    const previous = harness.sidebar.controller.snapshot();
    previous.messages = [{ id: 'retained-user', role: 'user', text: 'retained in previous conversation' }];
    harness.sidebar.controller.restoreSnapshot(previous);
    const previousController = harness.sidebar.controller;
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalSelect = previousController.select.bind(previousController);
    previousController.select = async (selection) => {
      entered.resolve();
      await release.promise;
      await originalSelect(selection);
    };

    const sending = harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must not escape the old controller',
    });
    await entered.promise;
    await harness.sidebar.newChat();
    const front = harness.sidebar.controller;
    assert.notEqual(front, previousController);
    release.resolve();
    await sending;

    assert.deepEqual(runs, []);
    assert.equal(factoryCalls, 0);
    assert.equal(front.snapshot().messages.length, 0);
    assert.equal(front.snapshot().selection.provider, 'codex');
    assert.equal(previousController.snapshot().messages[0]?.text, 'retained in previous conversation');
  } finally {
    await close(harness);
  }
});
