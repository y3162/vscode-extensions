import assert from 'node:assert/strict';

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentUpdate } from '../../src/types.js';

import { commands, env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'round11-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round11-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  })) as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('removing an additional directory in Japanese resets the live session and reports the localized reason', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = withSession();
  const additional = path.join(harness.root, 'round11-additional');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start before adding directory' });
    window.openDialogQueue.push([Uri.file(additional)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'start before removing directory' });
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: additional });

    const controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls');
    assert.deepEqual(controls?.codex?.additionalDirectories, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('設定を変更したため、新しい会話になりました。')));
  } finally {
    await close(harness);
  }
});
