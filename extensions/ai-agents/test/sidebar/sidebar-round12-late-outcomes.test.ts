import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';
import { env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round12-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round12-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
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

test('a Git-context send is refused if provider changes while its asynchronous context is being gathered', async () => {
  resetVscode();
  let factoryCalls = 0;
  const harness = withSession(async () => {
    factoryCalls += 1;
    return { sessionId: 'round12-stale-context-session', async run() {}, async dispose() {} };
  });
  const bin = path.join(harness.root, 'synthetic-bin');
  mkdirSync(bin, { recursive: true });
  const marker = path.join(harness.root, 'git-started.log');
  const fakeGit = path.join(bin, 'git');
  writeFileSync(fakeGit, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'started\\n');\nprocess.stdout.write('synthetic Git context');\nsetTimeout(() => process.exit(0), 350);\n`);
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/diff inspect' });
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(marker), 'the synthetic Git subprocess started before the selection changed');

    await harness.sidebar.controller.select({ provider: 'cursor', cwd: harness.workspacePath, model: '' });
    await assert.rejects(sending, /送信準備中に会話の設定が変更されました/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false,
      'stale context is discarded before creating a user turn');
    assert.equal(factoryCalls, 0, 'the invalidated prompt never creates or invokes a backend session');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await close(harness);
  }
});

test('rewind previews show up to eight file names without the overflow marker in both locales', async () => {
  for (const scenario of [
    { locale: 'en-US', files: ['one.txt'], expected: 'Files to restore (1): one.txt', omitted: ', and more' },
    { locale: 'ja-JP', files: Array.from({ length: 8 }, (_value, index) => `file-${index}.txt`), expected: '復元するファイル (8): file-0.txt', omitted: '、ほか' },
  ]) {
    resetVscode();
    env.language = scenario.locale;
    const harness = withSession();
    try {
      await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed rewind preview' });
      const controller = harness.sidebar.controller as unknown as {
        previewRewind(id: string): Promise<{ targetId: string; prompt: string; removedTurns: number; files: string[] }>;
      };
      const turn = harness.sidebar.controller.snapshot().turns[0]!;
      controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'short prompt', removedTurns: 1, files: scenario.files });
      window.warningQueue.push({ value: undefined });

      await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'replacement' });

      const prompt = window.warningMessages.at(-1) ?? '';
      assert.ok(prompt.includes(scenario.expected));
      assert.equal(prompt.includes(scenario.omitted), false, 'the overflow marker is reserved for previews with more than eight files');
      assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed rewind preview'), true,
        'cancelling the confirmation leaves the original conversation visible');
    } finally {
      await close(harness);
    }
  }
});

test('diagnostics omit an empty workspace cwd and let Cursor CLI resolve from its process cwd', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const cli = path.join(harness.root, 'cursor-cwd-diagnostics.cjs');
  writeFileSync(cli, "process.stdout.write(process.cwd() + '\\n');\n");
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: '' });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-in' }) });

    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const report = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(report, /OK Cursor CLI \(override\)/);
    assert.ok(report.split(process.cwd()).length - 1 >= 2, 'both version and status run without a workspace cwd');
    assert.match(report, /OK Cursor SDK auth\nlogged-in/);
    assert.equal(harness.sidebar.controller.snapshot().selection.cwd, '');
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});

test('the background-session cap falls back to the user prompt when an indexed title is empty', async () => {
  resetVscode();
  const entered = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  const release = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  workspace.configuration['ai-agents']!.maxBackgroundSessions = 1;
  const harness = withSession(async () => ({
    sessionId: 'round12-empty-title-session',
    async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      entered.resolve();
      await release.promise;
      emit({ id: 'round12-cap-final', role: 'assistant', text: 'complete', final: true });
    },
    async dispose() {},
  }));
  const prompt = 'This prompt is the visible fallback when the indexed title is blank and long enough to be shortened';
  let sending: Promise<void> | undefined;
  try {
    sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt });
    await entered.promise;
    const active = harness.sidebar.controller;
    active.rememberSession({
      id: 'round12-empty-title-session', title: '', updatedAt: '2026-10-18T00:00:00.000Z', provider: 'codex', cwd: harness.workspacePath,
    } satisfies SessionSummary);
    await harness.sidebar.handleMessage({ type: 'newChat' });

    await assert.rejects(
      harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'must remain unsent' }),
      new RegExp(prompt.slice(0, 40)),
    );
    assert.equal(harness.sidebar.controller.snapshot().messages.length, 0);
    assert.equal(active.snapshot().busy, true, 'the cap check leaves the original running session unchanged');
    release.resolve();
    await sending;
    assert.equal(active.snapshot().busy, false);
  } finally {
    release.resolve();
    await sending?.catch(() => undefined);
    await close(harness);
  }
});
