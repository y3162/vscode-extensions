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

test('adding and removing an additional directory persists settings and resets a live session', async () => {
  resetVscode();
  const harness = withSession();
  const additional = path.join(harness.root, 'additional');
  mkdirSync(additional, { recursive: true });
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active before directory change' });
    window.openDialogQueue.push([Uri.file(additional)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    let controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex;
    assert.deepEqual(controls?.additionalDirectories, [additional]);
    assert.equal(harness.sidebar.controller.hasSession(), false, 'changing allowed directories resets the session that used the old policy');

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active before removing directory' });
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: additional });
    controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex;
    assert.deepEqual(controls?.additionalDirectories, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('Started a new conversation')));
  } finally {
    await close(harness);
  }
});
