import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('unsupported built-in review expands referenced files into the sent prompt without invoking review API', async () => {
  resetVscode();
  const runs: string[] = [];
  const reviews: string[] = [];
  const harness = withSession(async () => ({
    sessionId: 'round10-review-fallback',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `round10-answer-${runs.length}`, role: 'assistant', text: 'processed', final: true });
    },
    async review(target: 'uncommitted' | 'base') { reviews.push(target); },
    async dispose() {},
  }));
  writeFileSync(path.join(harness.workspacePath, 'review-notes.md'), 'synthetic review context');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed the SDK session' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/review @review-notes.md' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/review' });

    assert.equal(reviews.length, 0, 'the SDK capability policy routes review through the prompt fallback');
    assert.equal(runs.length, 3);
    assert.match(runs[1] ?? '', /--- Context: review-notes\.md ---/);
    assert.match(runs[1] ?? '', /synthetic review context/);
    assert.match(runs[1] ?? '', /@review-notes\.md/);
    assert.match(runs[1] ?? '', /git status:\n/);
    assert.match(runs[2] ?? '', /Review the current changes\./, 'a bare built-in uses the default review instruction');
    assert.match(runs[2] ?? '', /git status:\n/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user' && message.text === '/review @review-notes.md'), true);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'processed'), true);
  } finally {
    await close(harness);
  }
});
