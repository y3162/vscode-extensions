import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, SendExtras } from '../../src/types.js';

import { extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round16-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round16-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
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

test('retry uses the saved expanded prompt and attachments when present', async () => {
  resetVscode();
  const runs: Array<{ prompt: string; extras?: SendExtras }> = [];
  const harness = withSession(async () => ({
    sessionId: 'round16-preserved-retry',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras) {
      runs.push({ prompt, extras });
      emit({ id: `round16-retry-${runs.length}`, role: 'assistant', text: 'completed', final: true });
    },
    async dispose() {},
  }));
  const contextFile = path.join(harness.workspacePath, 'retry-context.txt');
  writeFileSync(contextFile, 'original context body');
  try {
    const displayPrompt = 'Read @retry-context.txt';
    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: displayPrompt, attachments: ['notes.md'],
    });
    const originalUser = harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user');
    assert.ok(originalUser);
    assert.match(runs[0]?.prompt ?? '', /original context body/);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: originalUser.id });

    writeFileSync(contextFile, 'changed context body');
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: displayPrompt });

    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.prompt, runs[0]?.prompt, 'retry reuses the exact expanded prompt saved with the original turn');
    assert.doesNotMatch(runs[1]?.prompt ?? '', /changed context body/);
    assert.equal(runs[1]?.extras?.retryOf, originalUser.id);
    assert.deepEqual(runs[1]?.extras?.attachments, ['notes.md'], 'omitted retry attachments come from the saved request');
    assert.deepEqual(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.id), [originalUser.id]);
  } finally {
    await close(harness);
  }
});

test('resending a completed message creates a new user turn', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withSession(async () => ({
    sessionId: 'resend-completed-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `resend-answer-${runs.length}`, role: 'assistant', text: 'completed', final: true });
    },
    async dispose() {},
  }));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'Repeat this' });
    const first = harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user');
    assert.ok(first);
    await harness.sidebar.handleMessage({ type: 'prepareResend', id: first.id });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'Repeat this' });
    assert.deepEqual(runs, ['Repeat this', 'Repeat this']);
    const users = harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user');
    assert.equal(users.length, 2);
    assert.notEqual(users[0]?.id, users[1]?.id);
  } finally {
    await close(harness);
  }
});

test('retry without a saved prompt stays blocked until saved attachments are supplied again', async () => {
  resetVscode();
  const runs: Array<{ prompt: string; extras?: SendExtras }> = [];
  const harness = withSession(async () => ({
    sessionId: 'round16-missing-retry-input',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras) {
      runs.push({ prompt, extras });
      emit({ id: 'round16-missing-retry-final', role: 'assistant', text: 'completed', final: true });
    },
    async dispose() {},
  }));
  try {
    const state = harness.sidebar.controller.snapshot();
    state.messages = [{ id: 'round16-archived-user', role: 'user', text: 'retry the archived task', attachments: ['notes.md'] }];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'round16-archived-user' });
    assert.equal(runs.length, 0);

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retry the archived task' }),
      /添付を再指定してから再送してください/,
    );
    assert.equal(runs.length, 0, 'missing original attachment bytes never reach the backend');

    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retry the archived task', attachments: ['notes.md'],
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.prompt, 'retry the archived task', 'without a saved run input, the submitted prompt is expanded and sent');
    assert.equal(runs[0]?.extras?.retryOf, 'round16-archived-user');
    assert.deepEqual(runs[0]?.extras?.attachments, ['notes.md']);
    assert.deepEqual(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.id), ['round16-archived-user']);
  } finally {
    await close(harness);
  }
});
