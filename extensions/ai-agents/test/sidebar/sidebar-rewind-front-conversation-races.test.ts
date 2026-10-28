import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions as ProviderSessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, settle, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withSession(factory: (options: ProviderSessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function rewindSession(runs: string[], forks: string[]): AgentSession {
  return {
    sessionId: 'rewind-race-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `rewind-answer-${runs.length}`, role: 'assistant', text: `answer ${prompt}`, final: true, backendTurnId: `backend-turn-${runs.length}` });
    },
    async forkBeforeTurn(turnId: string) { forks.push(turnId); return `fork-${turnId}`; },
    async dispose() {},
  };
}

test('rewind stops before confirmation if the front conversation changes while preparing the preview', async () => {
  resetVscode();
  const runs: string[] = [];
  const forks: string[] = [];
  const harness = withSession(async () => rewindSession(runs, forks));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep original turn' });
    const previous = harness.sidebar.controller;
    const before = previous.snapshot();
    const turnId = before.turns[0]?.id;
    assert.ok(turnId);
    const entered = deferred<void>();
    const release = deferred<void>();
    previous.previewRewind = async () => {
      entered.resolve();
      await release.promise;
      return { targetId: turnId, prompt: 'keep original turn', removedTurns: 1, files: [] };
    };

    const rewind = harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: 'replacement' });
    await entered.promise;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    const replacement = harness.sidebar.controller;
    release.resolve();
    await assert.rejects(rewind, /巻き戻し確認中に対象の会話が切り替わりました/);

    assert.notEqual(replacement, previous);
    assert.deepEqual(previous.snapshot().messages, before.messages);
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.deepEqual(runs, ['keep original turn']);
    assert.deepEqual(forks, []);
    assert.equal(window.warningMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('rewind stops after confirmation if a new front conversation was opened while the prompt was visible', async () => {
  resetVscode();
  const runs: string[] = [];
  const forks: string[] = [];
  const harness = withSession(async () => rewindSession(runs, forks));
  const promptShown = deferred<void>();
  const confirmation = deferred<string | undefined>();
  const originalWarning = window.showWarningMessage;
  window.showWarningMessage = () => {
    promptShown.resolve();
    return confirmation.promise;
  };
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep original turn' });
    const previous = harness.sidebar.controller;
    const before = previous.snapshot();
    const turnId = before.turns[0]?.id;
    assert.ok(turnId);
    previous.previewRewind = async () => ({ targetId: turnId, prompt: 'keep original turn', removedTurns: 1, files: [] });

    const rewind = harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: 'replacement' });
    await promptShown.promise;
    await harness.sidebar.handleMessage({ type: 'newChat' });
    const replacement = harness.sidebar.controller;
    confirmation.resolve('Rewind and resend');
    await assert.rejects(rewind, /巻き戻し確認中に対象の会話が切り替わりました/);

    assert.notEqual(replacement, previous);
    assert.deepEqual(previous.snapshot().messages, before.messages);
    assert.equal(replacement.snapshot().messages.length, 0);
    assert.deepEqual(runs, ['keep original turn']);
    assert.deepEqual(forks, []);
  } finally {
    confirmation.resolve(undefined);
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});
