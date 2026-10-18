import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('settings and interaction routes preserve validated approval and resolve only valid payloads', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', approval: 'on-request' });
    assert.equal(harness.context.workspaceState.get<Record<string, { backend: string; approval: string }>>('ai-agents.controls')?.codex?.backend, 'app-server');
    assert.equal(harness.context.workspaceState.get<Record<string, { backend: string; approval: string }>>('ai-agents.controls')?.codex?.approval, 'on-request');

    const permission = harness.sidebar.controller.interactions.requestPermission({ id: 'late-permission', title: 'Write file', detail: 'notes.md', kind: 'write' });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission' });
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission', decision: 'allow' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission?.id, 'late-permission');
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission', decision: 'allow-session' });
    assert.equal(await permission, 'allow-session');

    const plan = harness.sidebar.controller.interactions.requestPlan({ id: 'late-plan', plan: '# Plan', todos: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 9, decision: 'accepted' });
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'late-plan' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan?.id, 'late-plan');
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'late-plan', decision: 'rejected' });
    assert.equal(await plan, 'rejected');

    const answers = harness.sidebar.controller.interactions.requestAnswers({
      id: 'late-question', questions: [{ id: 'continue', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 10, answers: { continue: ['yes'] } });
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion?.id, 'late-question');
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 'late-question', answers: { continue: ['yes'] } });
    assert.deepEqual(await answers, { continue: ['yes'] });
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion, null);
  } finally {
    await close(harness);
  }
});
