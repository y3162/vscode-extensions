import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round12-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round12-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
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

test('the background-session cap falls back to the user prompt when an indexed title is empty', async () => {
  resetVscode();
  const entered = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  const release = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
  const harness = withSession(async () => ({
    sessionId: 'round12-empty-title-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      entered.resolve();
      await release.promise;
      emit({ id: 'round12-cap-final', role: 'assistant', text: 'complete', final: true });
    },
    async dispose() {},
  }));
  const prompt = 'This prompt is the visible fallback when the indexed title is blank and long enough to be shortened';
  let sending: Promise<void> | undefined;
  try {
    sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt });
    await entered.promise;
    const active = harness.sidebar.controller;
    active.rememberSession({
      id: 'round12-empty-title-session', title: '', updatedAt: '2026-10-18T00:00:00.000Z', provider: 'codex', cwd: harness.workspacePath,
    } satisfies SessionSummary);
    await harness.sidebar.handleMessage({ type: 'newChat' });

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
      new RegExp(prompt.slice(0, 40)),
    );
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(active.snapshot().busy, true, 'the cap check leaves the original running session unchanged');
    release.resolve();
    await sending;
    assert.equal(active.snapshot().busy, false);
  } finally {
    release.resolve();
    await sending?.catch(() => undefined);
    await close(harness);
  }
});
