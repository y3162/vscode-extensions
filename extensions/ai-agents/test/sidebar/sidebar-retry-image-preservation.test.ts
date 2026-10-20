import assert from 'node:assert/strict';

import { rmSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, ImageAttachment, Selection, SessionSummary } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { resetVscode, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

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

test('retryPrepared returns the original image and retrying reuses it without duplicating the user message', async () => {
  resetVscode();
  const runs: Array<{ prompt: string; extras?: { retryOf?: string; images?: ImageAttachment[] } }> = [];
  const harness = withFactory(async () => ({
    sessionId: 'image-retry-session',
    async run(prompt, _signal, emit, extras) {
      runs.push({ prompt, extras });
      emit({ id: `image-retry-answer-${runs.length}`, role: 'assistant', text: `answer ${runs.length}`, final: true });
    },
    async dispose() {},
  }));
  const view = createView();
  const image: ImageAttachment = { mimeType: 'image/png', data: 'aGVsbG8=', name: 'fixture.png' };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'inspect this image', images: [image] });
    const originalUser = harness.sidebar.controller.snapshot().messages.find((message) => message.role === 'user');
    if (!originalUser) throw new Error('send should retain the original image-bearing user message');

    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: originalUser.id }, view as never);
    const prepared = view.messages.filter((message) => message.type === 'retryPrepared').at(-1);
    assert.deepEqual(prepared?.images, [image]);
    const latestState = view.messages.filter((message) => message.type === 'state').at(-1) as { shell?: { conversationId?: string } } | undefined;
    assert.equal(prepared?.conversationId, latestState?.shell?.conversationId, 'retry response must match the active webview conversation key');
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'inspect this image' });

    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0]?.extras?.images, [image]);
    assert.deepEqual(runs[1]?.extras?.images, [image], 'omitted retry images reuse the saved original bytes');
    assert.equal(runs[1]?.extras?.retryOf, originalUser.id);
    assert.equal(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);

    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: originalUser.id }, view as never);
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'inspect this image', images: [] });
    assert.equal(runs.length, 3);
    assert.deepEqual(runs[2]?.extras?.images, [], 'an explicit empty image list means the user removed every image');
    assert.equal(runs[2]?.extras?.retryOf, originalUser.id);
  } finally {
    await close(harness);
  }
});
