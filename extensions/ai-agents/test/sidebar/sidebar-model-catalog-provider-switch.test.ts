import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, AgentUpdate, ImageAttachment, Selection, SessionSummary } from '../../src/types.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a failed catalog request after provider switch is discarded without posting an error to the new provider', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const started = deferred<void>();
  const lateFailure = deferred<AgentModel[]>();
  harness.sidebar.listAvailableModels = async (selection: Selection) => {
    if (selection.provider === 'codex') {
      started.resolve();
      return lateFailure.promise;
    }
    return [];
  };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    const request = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 81, refresh: true });
    await started.promise;
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    lateFailure.reject(new Error('late codex discovery failure'));
    await request;

    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(view.messages.some((message) => message.type === 'modelCatalog' && message.requestId === 81), false);
    assert.equal(window.errorMessages.some((message) => message.includes('late codex discovery failure')), false);
  } finally {
    lateFailure.resolve([]);
    await close(harness);
  }
});
