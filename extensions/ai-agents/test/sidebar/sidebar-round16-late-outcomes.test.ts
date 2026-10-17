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

function installReadyPlan(harness: Harness, id: string): void {
  const state = harness.sidebar.controller.snapshot();
  state.plan = {
    phase: 'ready',
    revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: '# Round 16' }],
    current: { id, revision: 1, markdown: '# Round 16', todos: [], source: 'assistant-text', createdAt: 1 },
    build: { selection: { ...state.selection, model: 'saved-build-model' }, label: 'Saved build model' },
  };
  harness.sidebar.controller.restoreSnapshot(state);
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

test('background cap falls back from blank image-only prompt to session ID or running label', async () => {
  for (const sessionId of ['round16-image-only-session', ''] as const) {
    resetVscode();
    workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = withSession(async () => ({
      sessionId,
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        entered();
        await gate;
        emit({ id: 'round16-image-final', role: 'assistant', text: 'done', final: true });
      },
      async dispose() {},
    }));
    let sending: Promise<void> | undefined;
    try {
      sending = harness.sidebar.handleMessage({
        type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '',
        images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      });
      await started;
      const active = harness.sidebar.controller;
      const user = active.snapshot().messages.find((message) => message.role === 'user');
      assert.equal(user?.text, '', 'image-only turns can have no user-visible text title');
      await harness.sidebar.handleMessage({ type: 'newChat' });

      await assert.rejects(
        harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
        sessionId ? /round16-image-only-session/ : /running/,
      );
      assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
      assert.equal(active.snapshot().busy, true);
    } finally {
      release();
      await sending?.catch(() => undefined);
      await close(harness);
    }
  }
});

test('build model without an ID is rejected, and a blank Build label falls back to the model ID', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    let catalogCalls = 0;
    harness.sidebar.listAvailableModels = async () => { catalogCalls += 1; return [{ id: 'round16-build-model', label: '' }]; };
    installReadyPlan(harness, 'round16-model-plan');
    const originalBuild = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await assert.rejects(harness.sidebar.handleMessage({ type: 'setBuildModel' }), /モデル一覧に、そのモデルはありません/);
    assert.equal(catalogCalls, 1);
    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, originalBuild);

    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: { model: string }): Promise<void>;
    };
    controller.build = async (_planId, _revision, selection) => {
      const state = harness.sidebar.controller.snapshot();
      state.selection = { ...state.selection, model: selection.model };
      state.plan.phase = 'implemented';
      harness.sidebar.controller.restoreSnapshot(state);
    };
    await harness.sidebar.handleMessage({
      type: 'buildPlan', planId: 'round16-model-plan', revision: 1, modelId: 'round16-build-model', label: '', modelParams: [],
    });

    const selected = harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(selected, { model: 'round16-build-model', label: 'round16-build-model', hasDetails: false });
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'implemented');
  } finally {
    await close(harness);
  }
});

test('setBuildParam with no id is a no-op on the saved Build selection', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    installReadyPlan(harness, 'round16-param-plan');
    const saved = structuredClone(harness.sidebar.controller.snapshot().plan.build);

    await harness.sidebar.handleMessage({ type: 'setBuildParam', value: 'high' });

    assert.deepEqual(harness.sidebar.controller.snapshot().plan.build, saved);
    assert.equal(harness.sidebar.controller.snapshot().plan.current?.id, 'round16-param-plan');
  } finally {
    await close(harness);
  }
});

test('an empty extension list completes icon theme lookup and keeps per-file badge icons', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'round16-missing-theme' };
  const harness = openSidebar();
  const view = createView();
  try {
    assert.equal(extensions.all.length, 0);
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'unchanged-theme.ts', kind: 'update', previousText: 'before' }];
    state.messages = [{ id: 'round16-icon-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'unchanged-theme.ts', kind: 'update', previousText: 'before' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    const sent = view.messages.filter((message) => message.type === 'state').at(-1) as {
      messages: { upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: { type?: string; badge?: string } }> } }> };
      shell: { changes: Array<{ icon?: { type?: string; badge?: string } }> };
    };
    const messageIcon = sent.messages.upserts.find((message) => message.id === 'round16-icon-message')?.meta?.files?.[0]?.icon;
    assert.deepEqual(messageIcon, { type: 'badge', badge: 'TS' });
    assert.deepEqual(sent.shell.changes[0]?.icon, { type: 'badge', badge: 'TS' });
  } finally {
    await close(harness);
  }
});

test('relative openFile is refused when the selected conversation has no workspace cwd', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'relative-without-cwd.txt');
  writeFileSync(file, 'keep user data');
  try {
    const state = harness.sidebar.controller.snapshot();
    state.selection = { ...state.selection, cwd: '' };
    harness.sidebar.controller.restoreSnapshot(state);

    await assert.rejects(harness.sidebar.handleMessage({ type: 'openFile', path: 'relative-without-cwd.txt' }), /ワークスペース外/);

    assert.equal(window.visibleEditors.length, 0, 'a relative path is not guessed from the first workspace folder');
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8')), 'keep user data');
  } finally {
    await close(harness);
  }
});
