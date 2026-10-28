import assert from 'node:assert/strict';

import { mkdirSync, rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

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

test('a send from a known background conversation cannot alter the empty front conversation', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: `round17-background-${runs.length + 1}`,
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: `round17-background-answer-${runs.length}`, role: 'assistant', text: `completed ${prompt}`, final: true });
    },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'retain background history' });
    const background = harness.sidebar.controller;
    const backgroundId = (view.messages.filter((message) => message.type === 'state').at(-1)?.shell as { conversationId?: string } | undefined)?.conversationId;
    assert.ok(backgroundId);

    await harness.sidebar.newChat();
    const front = harness.sidebar.controller;
    assert.notEqual(front, background, 'newChat creates a distinct front controller');
    const frontBefore = front.snapshot();
    const backgroundBefore = background.snapshot();
    await harness.sidebar.handleMessage({
      type: 'send', conversationId: backgroundId, provider: 'codex', cwd: harness.workspacePath, prompt: 'must not run from a stale view',
    });

    assert.deepEqual(runs, ['retain background history']);
    assert.deepEqual(front.snapshot(), frontBefore, 'the stale event cannot create user content or start work on the front');
    assert.deepEqual(background.snapshot(), backgroundBefore, 'the stale event cannot append to the background conversation');
    assert.equal(front.hasSession(), false);
  } finally {
    await close(harness);
  }
});
