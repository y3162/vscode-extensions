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

test('usage and instruction inspectors retain readable runtime errors instead of rejecting the webview request', async () => {
  resetVscode();
  const harness = withSession(async () => ({
    sessionId: 'inspector-errors',
    async run() {},
    async rateLimits() { throw new Error('synthetic rate limits failure'); },
    async instructions() { throw new Error('synthetic instructions failure'); },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.controller.openSession();
    await harness.sidebar.handleMessage({ type: 'usage' });
    await harness.sidebar.handleMessage({ type: 'instructions' });
    const inspectors = view.messages.filter((message) => message.type === 'inspector');
    assert.match(String(inspectors.find((message) => message.title === 'Usage')?.text), /synthetic rate limits failure/);
    assert.match(String(inspectors.find((message) => message.title === 'Rules \/ Skills \/ MCP')?.text), /synthetic instructions failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'codex');
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
