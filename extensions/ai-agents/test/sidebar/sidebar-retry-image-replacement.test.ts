import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import type { AgentSession, AgentUpdate, SendExtras } from '../../src/types.js';

import { AgentsSidebar } from '../../src/sidebar.js';

import { env, resetVscode, window } from '../support/vscode-stub.js';

import { openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('retry replaces saved images with newly supplied retry images while preserving the prompt', async () => {
  resetVscode();
  const runs: Array<{ prompt: string; extras?: SendExtras }> = [];
  const harness = withSession(async () => ({
    sessionId: 'round17-image-retry',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void, extras?: SendExtras) {
      runs.push({ prompt, extras });
      emit({ id: `round17-image-answer-${runs.length}`, role: 'assistant', text: 'image reviewed', final: true });
    },
    async dispose() {},
  }));
  const originalImage = { mimeType: 'image/png', data: 'aGVsbG8=', name: 'original.png' };
  const replacementImage = { mimeType: 'image/jpeg', data: 'bmV3LWltYWdl', name: 'replacement.jpg' };

  try {
    const prompt = 'Compare this image with the previous result';
    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt, images: [originalImage],
    });
    const originalUser = harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user');
    assert.ok(originalUser, 'the first image turn is recorded before retry is prepared');
    assert.deepEqual(runs[0]?.extras?.images, [originalImage]);

    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: originalUser.id });
    await harness.sidebar.handleMessage({
      type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt, images: [replacementImage],
    });

    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.prompt, runs[0]?.prompt, 'retry keeps the original expanded prompt');
    assert.equal(runs[1]?.extras?.retryOf, originalUser.id);
    assert.deepEqual(runs[1]?.extras?.images, [replacementImage], 'newly supplied image replaces the saved image payload');
    assert.deepEqual(
      harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.id),
      [originalUser.id],
      'retry updates the existing turn instead of creating a duplicate user turn',
    );
  } finally {
    await close(harness);
  }
});
