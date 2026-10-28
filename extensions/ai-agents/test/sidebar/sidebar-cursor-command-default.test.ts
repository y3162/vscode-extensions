import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

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

test('an empty Cursor executable setting falls back to the default agent command', async () => {
  resetVscode();
  let optionsSeen: SessionOptions | undefined;
  const harness = withFactory(async (options) => {
    optionsSeen = options;
    return {
      sessionId: 'cursor-command-default',
      async run(_prompt, _signal, emit) { emit({ id: 'cursor-default-answer', role: 'assistant', text: 'done', final: true }); },
      async dispose() {},
    };
  });
  workspace.configuration['ai-agents']!['cursor.agentPath'] = '';
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: harness.workspacePath, prompt: 'check configured command' });

    assert.equal(optionsSeen?.agentPath, 'agent');
    assert.equal(optionsSeen?.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'done'), true);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
  } finally {
    await close(harness);
  }
});
