import assert from 'node:assert/strict';

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, prepareHarnessRoot, waitFor, type Harness, type HarnessPaths } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>, prepare?: (paths: HarnessPaths) => void): Harness {
  const paths = prepareHarnessRoot();
  prepare?.(paths);
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('ready Sidebar sets the busy command context on run start and clears it after completion', async () => {
  resetVscode();
  let releaseRun!: () => void;
  let markStarted!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const harness = withSession(async () => ({
    sessionId: 'busy-session',
    async run(_prompt, _signal, emit) {
      markStarted();
      await runGate;
      emit({ id: 'answer', role: 'assistant', text: 'completed', final: true, backendTurnId: 'busy-turn' });
    },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'hold' });
    await started;
    await waitFor(() => commands.executed.some((entry) => entry.command === 'setContext' && entry.args[0] === 'ai-agents.busy' && entry.args[1] === true), 'busy context');
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    releaseRun();
    await sending;
    await waitFor(() => commands.executed.some((entry) => entry.command === 'setContext' && entry.args[0] === 'ai-agents.busy' && entry.args[1] === false), 'idle context');
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
    assert.deepEqual(commands.executed.filter((entry) => entry.command === 'setContext' && entry.args[0] === 'ai-agents.busy').map((entry) => entry.args[1]), [true, false]);
  } finally {
    releaseRun();
    await close(harness);
  }
});
