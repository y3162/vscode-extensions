import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, env, languages, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('the background-session cap reports the indexed title and keeps the replacement front empty', async () => {
  resetVscode();
  const entered = deferred<void>();
  const release = deferred<void>();
  let factoryCalls = 0;
  const harness = withFactory(async () => {
    factoryCalls += 1;
    return {
      sessionId: 'round12-indexed-running',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        entered.resolve();
        await release.promise;
        emit({ id: 'round12-running-final', role: 'assistant', text: 'finished', final: true });
      },
      async dispose() {},
    };
  });
  workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
  let sending: Promise<void> | undefined;
  try {
    sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'held background request' });
    await entered.promise;
    const background = harness.sidebar.controller;
    background.rememberSession({
      id: 'round12-indexed-running', title: 'Known running session title', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', cwd: harness.workspacePath,
    } satisfies SessionSummary);
    await harness.sidebar.handleMessage({ type: 'newChat' });

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
      /Known running session title/,
    );
    assert.equal(factoryCalls, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(background.snapshot().busy, true);

    release.resolve();
    await sending;
    assert.equal(background.snapshot().busy, false);
    assert.equal(background.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'finished'), true);
  } finally {
    release.resolve();
    await sending?.catch(() => undefined);
    await close(harness);
  }
});
