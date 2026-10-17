import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentSession, Selection, SessionSummary } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { commands, env, resetVscode, window } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

function session(id: string): AgentSession {
  return {
    sessionId: id,
    async run(prompt, _signal, emit) {
      emit({ id: `${id}-answer`, role: 'assistant', text: `answer to ${prompt}`, final: true });
    },
    async dispose() {},
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('the apiKey webview route delegates to the selected provider command', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    await harness.sidebar.handleMessage({ type: 'apiKey' });
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    await harness.sidebar.handleMessage({ type: 'apiKey' });

    assert.deepEqual(commands.executed.map(({ command }) => command), [
      'ai-agents.setCodexApiKey', 'ai-agents.setCursorApiKey',
    ]);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
  } finally {
    await close(harness);
  }
});

test('stale conversation actions are dropped and a terminal that disappeared cannot be opened', async () => {
  resetVscode();
  let factoryCalls = 0;
  const harness = withSession(async () => {
    factoryCalls += 1;
    return {
      sessionId: 'terminal-disappeared',
      async run() {},
      async listBackgroundTerminals() { return []; },
      async dispose() {},
    };
  });
  try {
    await harness.sidebar.handleMessage({ type: 'send', conversationId: 'already-closed-conversation', provider: 'codex', cwd: harness.workspacePath, prompt: 'must not send' });
    assert.equal(factoryCalls, 0);
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'create current session' });
    await harness.sidebar.handleMessage({ type: 'openTerminal', processId: 42 });
    await assert.rejects(harness.sidebar.handleMessage({ type: 'openTerminal', processId: 'ended-process' }), /終了しています/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'must not send'), false);
    assert.equal(factoryCalls, 1);
  } finally {
    await close(harness);
  }
});

test('history uses global storage when the workspace storage URI is unavailable', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  Object.defineProperty(paths.context, 'storageUri', { value: undefined });
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, async () => session('global-storage-fallback'));
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: paths.workspacePath, prompt: 'save through global storage' });
    const history = path.join(paths.context.globalStorageUri.fsPath, 'history', 'v1');
    await waitFor(() => existsSync(history) && readdirSync(history).some((name) => name.endsWith('.json')), 'global storage history snapshot');
    assert.equal(readdirSync(path.join(paths.root, 'storage')).some((name) => name === 'history'), false);
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.text === 'save through global storage'), true);
  } finally {
    await close(harness);
  }
});

test('Japanese model replacement asks before clearing the active SDK conversation', async () => {
  resetVscode();
  env.language = 'ja';
  const harness = withSession(async () => session('sdk-model-session'));
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'keep this conversation' });
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this conversation'));
    harness.sidebar.listAvailableModels = async () => [{ id: 'replacement-model', label: 'Replacement model' }];

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'replacement-model' });
    assert.match(window.warningMessages.at(-1) ?? '', /この変更は新しいセッションが必要です/, JSON.stringify({ controls: harness.context.workspaceState.get('ai-agents.controls'), state: harness.sidebar.controller.snapshot(), errors: window.errorMessages, logs: harness.output.lines }));
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this conversation'));

    window.warningQueue.push({ value: '新しいセッションにする' });
    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'replacement-model' });
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'replacement-model');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this conversation'), false);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex?.model, 'replacement-model');
  } finally {
    await close(harness);
  }
});

test('rewind confirmation summarizes long prompts and more than eight files in both locales', async () => {
  for (const locale of ['en', 'ja'] as const) {
    resetVscode();
    env.language = locale;
    const harness = withSession(async () => session(`rewind-copy-${locale}`));
    try {
      await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed prompt' });
      const turnId = harness.sidebar.controller.snapshot().turns[0]?.id;
      assert.ok(turnId);
      harness.sidebar.controller.previewRewind = async () => ({
        targetId: turnId,
        prompt: 'o'.repeat(181),
        removedTurns: 3,
        files: Array.from({ length: 10 }, (_value, index) => `file-${index}.txt`),
      });

      const edited = 'e'.repeat(181);
      await harness.sidebar.handleMessage({ type: 'rewind', turnId, editedText: edited });
      const body = window.warningMessages.at(-1) ?? '';

      assert.ok(body.includes('o'.repeat(180) + '…'));
      assert.ok(body.includes('e'.repeat(180) + '…'));
      assert.match(body, /10/);
      assert.ok(body.includes(['file-0.txt', 'file-1.txt', 'file-2.txt', 'file-3.txt', 'file-4.txt', 'file-5.txt', 'file-6.txt', 'file-7.txt'].join(', ')));
      assert.ok(body.includes(locale === 'ja' ? '、ほか' : ', and more'));
      assert.ok(body.includes(locale === 'ja' ? '後続ターン 2 件' : '2 later turn(s)'));
      assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed prompt'), true);
      assert.equal(harness.sidebar.controller.snapshot().busy, false);
    } finally {
      await close(harness);
    }
  }
});

test('restoring an indexed conversation without a backend safely handles picker cancel and resumes after selection', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'historical-app-server-thread',
    title: 'Historical conversation',
    updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex',
    cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  let factoryCalls = 0;
  let optionsSeen: SessionOptions | undefined;
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (options: SessionOptions) => {
    factoryCalls += 1;
    optionsSeen = options;
    return session(summary.id);
  }) as never);
  const harness = { ...paths, sidebar, output };
  try {
    window.quickPickQueue.push(undefined);
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.deepEqual(window.quickPickOffers.at(-1), ['sdk', 'app-server']);
    assert.equal(factoryCalls, 0, 'cancel must not construct or resume a backend session');
    assert.equal(sidebar.controller.sessionId(), undefined);

    window.quickPickQueue.push('app-server');
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(factoryCalls, 1);
    assert.equal(optionsSeen?.backend, 'app-server');
    assert.equal(optionsSeen?.resumeId, summary.id);
    assert.equal(sidebar.controller.sessionId(), summary.id);
    assert.equal(sidebar.controller.snapshot().selection.cwd, paths.workspacePath);
  } finally {
    await close(harness);
  }
});

test('Cursor diagnostics use synthetic auth results and report SDK status failures without contacting auth services', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-in' }) });
    await harness.sidebar.showDiagnostics();
    const success = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(success, /Cursor SDK auth\nlogged-in/);
    assert.match(success, /OK Backend\ncursor\/sdk/);

    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => { throw new Error('synthetic auth status failure'); } });
    await harness.sidebar.showDiagnostics();
    const failure = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(failure, /FAIL Cursor SDK auth\nsynthetic auth status failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');

    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const routed = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(routed, /FAIL Cursor SDK auth\nsynthetic auth status failure/);
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});
