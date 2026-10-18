import assert from 'node:assert/strict';

import { mkdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentModel, AgentSession, AgentUpdate } from '../../src/types.js';

import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a rejected catalog request superseded by refresh cannot publish a stale error', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const first = deferred<AgentModel[]>();
  const fresh: AgentModel = { id: 'round17-fresh-catalog', label: 'Fresh catalog model' };
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    calls += 1;
    if (calls === 1) {
      firstSignal = signal;
      return first.promise;
    }
    return [fresh];
  };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    const staleRequest = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 171, refresh: true });
    await waitFor(() => calls === 1, 'first model catalog request');

    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 172, refresh: true });
    assert.equal(firstSignal?.aborted, true, 'refresh aborts the superseded catalog transport');
    first.reject(new Error('stale catalog transport failed'));
    await staleRequest;

    const catalogs = view.messages.filter((message) => message.type === 'modelCatalog');
    assert.deepEqual(catalogs.map((message) => [message.requestId, message.status]), [[172, 'ready']]);
    assert.deepEqual((catalogs[0]?.models as Array<{ id: string }>).map((item) => item.id), [fresh.id]);
    assert.equal(window.errorMessages.some((message) => message.includes('stale catalog transport failed')), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
  } finally {
    first.reject(new Error('test cleanup'));
    await close(harness);
  }
});
