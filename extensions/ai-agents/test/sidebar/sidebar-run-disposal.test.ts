import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('disposing a Sidebar during a run cancels the deferred state flush and leaves the active session stopped', async () => {
  resetVscode();
  const entered = deferred<void>();
  const harness = withSession(async () => ({
    sessionId: 'dispose-running-session',
    async run(_prompt, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
      });
    },
    async dispose() {},
  }));
  try {
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'held request' });
    await entered.promise;
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    await harness.sidebar.dispose();
    await sending;

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.busy, false);
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.messages, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
  } finally {
    await close(harness);
  }
});
