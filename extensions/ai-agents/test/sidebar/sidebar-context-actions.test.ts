import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, Uri, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('context insertion waits for a ready webview and emits nothing when the editor has no selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    const inserting = harness.sidebar.insertContext('selection');
    await waitFor(() => commands.executed.some((entry) => entry.command === 'ai-agents.chat.focus'), 'focus request');
    assert.equal(harness.sidebar.isReady(), false);

    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await inserting;

    assert.equal(harness.sidebar.isReady(), true);
    assert.equal(view.messages.some((message) => message.type === 'insert'), false, 'missing selection does not fabricate context text');
  } finally {
    await close(harness);
  }
});

test('the diff built-in sends a synthetic workspace summary and keeps the original request visible', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: 'round11-diff-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: 'round11-diff-final', role: 'assistant', text: 'summary returned', final: true });
    },
    async dispose() {},
  }));
  writeFileSync(path.join(harness.workspacePath, 'change-notes.md'), 'synthetic diff context');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/diff Summarize @change-notes.md' });

    assert.equal(runs.length, 1);
    assert.match(runs[0] ?? '', /Summarize @change-notes\.md/);
    assert.match(runs[0] ?? '', /git status:\n/);
    assert.match(runs[0] ?? '', /--- Context: change-notes\.md ---/);
    assert.match(runs[0] ?? '', /synthetic diff context/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user' && message.text === '/diff Summarize @change-notes.md'), true);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'summary returned'), true);
    assert.ok(harness.output.lines.some((line) => line.includes('[codex/cli]') && line.includes(' start')));
    assert.ok(harness.output.lines.some((line) => line.includes('[codex/cli] idle')));
  } finally {
    await close(harness);
  }
});
