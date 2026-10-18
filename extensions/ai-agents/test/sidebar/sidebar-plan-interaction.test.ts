import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { resetVscode, env, window } from '../support/vscode-stub.js';

import { createView, openSidebar, settle, type Harness, type TestView } from '../support/vscode-harness.js';

async function ready(sidebar: Harness['sidebar'], view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('plan resolution ignores missing and unknown decisions until an explicit choice arrives', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    const resolution = harness.sidebar.controller.interactions.requestPlan({ id: 'plan-approval', plan: 'Keep the sandbox', todos: [] });
    await settle();

    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval' });
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval', decision: 'approve' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan?.id, 'plan-approval');

    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-approval', decision: 'accepted' });
    assert.equal(await resolution, 'accepted');
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan, null);
  } finally {
    await close(harness);
  }
});
