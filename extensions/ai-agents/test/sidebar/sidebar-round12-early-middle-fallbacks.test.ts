import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { commands, env, languages, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

test('a successful model refresh replaces the cache used by later menu selections', async () => {
  resetVscode();
  const harness = openSidebar();
  const catalogs: AgentModel[][] = [
    [{ id: 'round12-old-model', label: 'Old model' }],
    [{ id: 'round12-refreshed-model', label: 'Refreshed model' }],
  ];
  let calls = 0;
  harness.sidebar.listAvailableModels = async () => catalogs[calls++] ?? [];
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 120, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 121 });
    assert.equal(calls, 1, 'the ordinary request reuses the first cached result');
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 122, refresh: true });
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 123 });
    assert.equal(calls, 2, 'refresh performs a new lookup and populates the cache');
    assert.deepEqual((view.messages.filter((message) => message.type === 'modelCatalog').at(-1)?.models as Array<{ id: string }>).map((item) => item.id), ['round12-refreshed-model']);

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'round12-refreshed-model' });
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round12-refreshed-model');
    await assert.rejects(harness.sidebar.handleMessage({ type: 'setModel', modelId: 'round12-old-model' }), /モデル一覧に、そのモデルはありません/);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round12-refreshed-model');
    assert.equal(calls, 2, 'both menu selections resolve against the refreshed cache');
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels')?.codex?.label, 'Refreshed model');
  } finally {
    await close(harness);
  }
});

test('setModel rejects a busy conversation before discovering or persisting a replacement model', async () => {
  resetVscode();
  const entered = deferred<void>();
  const release = deferred<void>();
  const model: AgentModel = { id: 'round12-forbidden-replacement', label: 'Must not be applied' };
  let lookups = 0;
  const harness = withFactory(async () => ({
    sessionId: 'round12-busy-model',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      entered.resolve();
      await release.promise;
      emit({ id: 'round12-busy-final', role: 'assistant', text: 'done', final: true });
    },
    async dispose() {},
  }));
  harness.sidebar.listAvailableModels = async () => { lookups += 1; return [model]; };
  try {
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active protected turn' });
    await entered.promise;
    const before = harness.sidebar.controller.snapshot().selection;
    await assert.rejects(harness.sidebar.handleMessage({ type: 'setModel', modelId: model.id }), /実行が終わってからモデルを選択してください/);

    assert.equal(lookups, 0);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, before);
    assert.equal(harness.context.workspaceState.get('ai-agents.selectedModels'), undefined);
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    release.resolve();
    await sending;
    assert.equal(harness.sidebar.controller.snapshot().busy, false);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'done'), true);
  } finally {
    release.resolve();
    await close(harness);
  }
});

test('Japanese context routes attach only available content and label each supported context source', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = openSidebar();
  const view = createView();
  const file = path.join(harness.workspacePath, 'context file.ts');
  writeFileSync(file, 'const answer = 42;');
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    await harness.sidebar.insertContext('file');
    assert.equal(view.messages.some((message) => message.type === 'insert'), false, 'no active editor produces no file token');
    window.activeTextEditor = {
      document: { uri: Uri.file(file), getText: () => 'const answer = 42;', lineCount: 1, lineAt: () => ({ text: 'const answer = 42;' }) },
      selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
    await harness.sidebar.insertContext('file');
    let inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'ファイル');
    assert.equal(inserted?.text, '@"context file.ts" ');

    window.activeTextEditor = {
      document: { uri: Uri.file(file), getText: () => 'const answer = 42;', lineCount: 1, lineAt: () => ({ text: 'const answer = 42;' }) },
      selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 19 } },
    };
    await harness.sidebar.insertContext('selection');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, '選択範囲');
    assert.match(String(inserted?.text), /Context: selection context file\.ts:1-1/);

    languages.entries.push([Uri.file(file), [{ severity: 0, message: 'synthetic diagnostic', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]]);
    await harness.sidebar.insertContext('problems');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, '問題');
    assert.match(String(inserted?.text), /synthetic diagnostic/);

    await harness.sidebar.insertContext('git');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'Git 差分');
    assert.match(String(inserted?.text), /git status:\n/);

    window.shellListeners[0]?.({ exitCode: 0, execution: { commandLine: 'echo round12-context' } });
    await harness.sidebar.insertContext('terminal');
    inserted = view.messages.filter((message) => message.type === 'insert').at(-1);
    assert.equal(inserted?.label, 'ターミナル');
    assert.match(String(inserted?.text), /echo round12-context \(exit 0\)/);
  } finally {
    await close(harness);
  }
});

test('the background-session cap reports the indexed title and keeps the replacement front empty', async () => {
  resetVscode();
  const entered = deferred<void>();
  const release = deferred<void>();
  let factoryCalls = 0;
  const harness = withFactory(async () => {
    factoryCalls += 1;
    return {
      sessionId: 'round12-indexed-running',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        entered.resolve();
        await release.promise;
        emit({ id: 'round12-running-final', role: 'assistant', text: 'finished', final: true });
      },
      async dispose() {},
    };
  });
  workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
  let sending: Promise<void> | undefined;
  try {
    sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'held background request' });
    await entered.promise;
    const background = harness.sidebar.controller;
    background.rememberSession({
      id: 'round12-indexed-running', title: 'Known running session title', updatedAt: '2026-10-18T00:00:00.000Z',
      provider: 'codex', cwd: harness.workspacePath,
    } satisfies SessionSummary);
    await harness.sidebar.handleMessage({ type: 'newChat' });

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
      /Known running session title/,
    );
    assert.equal(factoryCalls, 1);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(background.snapshot().busy, true);

    release.resolve();
    await sending;
    assert.equal(background.snapshot().busy, false);
    assert.equal(background.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'finished'), true);
  } finally {
    release.resolve();
    await sending?.catch(() => undefined);
    await close(harness);
  }
});

test('empty Codex executable setting uses the bundled launcher and records its version before sending', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: 'round12-bundled-launch',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: 'round12-bundled-final', role: 'assistant', text: 'sent through fake transport', final: true });
    },
    async dispose() {},
  }));
  workspace.configuration['ai-agents']!['codex.executablePath'] = '';
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'exercise bundled launch metadata' });

    const start = harness.output.lines.find((line) => line.includes(' start')) ?? '';
    assert.match(start, /^\[codex\/sdk\] bundled \S+ /);
    assert.match(start, /codex\.js start$/);
    assert.deepEqual(runs, ['exercise bundled launch metadata']);
    assert.equal(harness.sidebar.controller.snapshot().status, 'idle');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'sent through fake transport'), true);
  } finally {
    await close(harness);
  }
});
