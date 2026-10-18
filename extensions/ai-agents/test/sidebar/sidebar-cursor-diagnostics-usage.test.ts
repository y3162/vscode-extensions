import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round9-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  }));
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, sessionFactory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('Cursor diagnostics report synthetic CLI and SDK status; usage shows live and unsupported backends', async () => {
  resetVscode();
  const harness = withSession(async () => ({
    sessionId: 'cursor-inspector-session',
    async run() {},
    async rateLimits() { return 'synthetic rate limits'; },
    async dispose() {},
  }));
  const view = createView();
  const cli = path.join(harness.root, 'cursor-agent.cjs');
  writeFileSync(cli, "process.stdout.write(process.argv[2] === '--version' ? 'Cursor fixture 0.1\\n' : 'status: ready\\n');\n");
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-in' }) });
    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const diagnostics = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(diagnostics, /OK Cursor CLI \(override\)/);
    assert.match(diagnostics, /Cursor fixture 0\.1/);
    assert.match(diagnostics, /status: ready/);
    assert.match(diagnostics, /OK Cursor SDK auth\nlogged-in/);
    assert.match(diagnostics, /Cursor sandbox helper/);

    await harness.sidebar.controller.openSession();
    const state = harness.sidebar.controller.snapshot();
    state.usage = { inputTokens: 120, outputTokens: 34, totalTokens: 154 };
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'usage' });
    const usage = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(usage, /Input 120 · Output 34 · Total 154/);
    assert.match(usage, /synthetic rate limits/);

    await harness.sidebar.handleMessage({ type: 'configure', backend: 'acp' });
    await harness.sidebar.handleMessage({ type: 'usage' });
    const unsupported = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(unsupported, /非対応 \/ Unsupported/);
    assert.equal(harness.sidebar.controller.hasSession(), false, 'switching backend drops the previous session before reporting unsupported usage');
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});
