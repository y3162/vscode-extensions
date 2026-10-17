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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'inspect this image' });

    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0]?.extras?.images, [image]);
    assert.deepEqual(runs[1]?.extras?.images, [image], 'omitted retry images reuse the saved original bytes');
    assert.equal(runs[1]?.extras?.retryOf, originalUser.id);
    assert.equal(harness.sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
  } finally {
    await close(harness);
  }
});

test('a failed catalog request after provider switch is discarded without posting an error to the new provider', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const started = deferred<void>();
  const lateFailure = deferred<AgentModel[]>();
  harness.sidebar.listAvailableModels = async (selection: Selection) => {
    if (selection.provider === 'codex') {
      started.resolve();
      return lateFailure.promise;
    }
    return [];
  };
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    const request = harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 81, refresh: true });
    await started.promise;
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    lateFailure.reject(new Error('late codex discovery failure'));
    await request;

    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(view.messages.some((message) => message.type === 'modelCatalog' && message.requestId === 81), false);
    assert.equal(window.errorMessages.some((message) => message.includes('late codex discovery failure')), false);
  } finally {
    lateFailure.resolve([]);
    await close(harness);
  }
});

test('refreshSessions merges Cursor SDK, live backend, and persisted summaries through the webview route', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const persisted: SessionSummary = {
    id: 'persisted-cursor-session', title: 'Persisted', updatedAt: '2026-10-17T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const sdk: SessionSummary = {
    id: 'sdk-cursor-session', title: 'SDK store', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  const live: SessionSummary = {
    id: 'live-cursor-session', title: 'Live backend', updatedAt: '2026-10-19T00:00:00.000Z',
    provider: 'cursor', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [persisted]);
  let listerOptions: { cwd: string; storagePath: string } | undefined;
  const sidebar = new AgentsSidebar(
    paths.context as never,
    output as never,
    (async (options: Pick<SessionOptions, 'cwd' | 'storagePath' | 'apiKey'>) => { listerOptions = options; return [sdk]; }) as never,
    (async (_options: SessionOptions) => ({
      sessionId: 'cursor-current-session',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) { emit({ id: 'cursor-current-answer', role: 'assistant', text: 'done', final: true }); },
      async listSessions() { return [live]; },
      async dispose() {},
    })) as never,
  );
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd: paths.workspacePath, prompt: 'open the current session' });
    await sidebar.handleMessage({ type: 'refreshSessions' });

    assert.equal(listerOptions?.cwd, paths.workspacePath);
    assert.ok(listerOptions?.storagePath.endsWith('cursor-agents'));
    const ids = sidebar.controller.snapshot().sessions.map((item) => item.id);
    assert.ok(ids.includes(persisted.id));
    assert.ok(ids.includes(sdk.id));
    assert.ok(ids.includes(live.id));
    assert.deepEqual(paths.context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex')?.map((item) => item.id), ids);
  } finally {
    await close(harness);
  }
});
