import assert from 'node:assert/strict';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round9-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
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

test('rewind handles the Japanese no-file preview and refuses missing local message or attachment data', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = withSession();
  const originalWarning = window.showWarningMessage;
  let confirmationArguments: unknown[] = [];
  window.showWarningMessage = (message: string, ...args: unknown[]) => {
    confirmationArguments = args;
    return originalWarning(message, ...args);
  };
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(): Promise<void>;
    };
    const original = harness.sidebar.controller.snapshot();
    const user = original.messages.find((message) => message.role === 'user')!;
    const turn = original.turns[0]!;
    controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'seed', removedTurns: 1, files: [] });
    controller.rewindAndSend = async () => {};
    controller.retryInput = () => undefined;

    const withoutUser = structuredClone(original);
    withoutUser.messages = withoutUser.messages.filter((message) => message.id !== user.id);
    harness.sidebar.controller.restoreSnapshot(withoutUser);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /ローカル履歴にありません/);

    harness.sidebar.controller.restoreSnapshot(original);
    const attachmentState = structuredClone(original);
    attachmentState.messages.find((message) => message.id === user.id)!.attachments = ['missing.md'];
    harness.sidebar.controller.restoreSnapshot(attachmentState);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /添付の元データが保存されていません/);

    const imageState = structuredClone(original);
    imageState.turns[0]!.imageCount = 1;
    harness.sidebar.controller.restoreSnapshot(imageState);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /元画像はローカル履歴に保存されていないため/);

    harness.sidebar.controller.restoreSnapshot(original);
    window.warningQueue.push({ value: undefined });
    await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' });
    assert.match(window.warningMessages.at(-1) ?? '', /復元するファイル変更はありません/);
    assert.ok(confirmationArguments.some((value) => value === '巻き戻して再実行'));
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed'), true);
  } finally {
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});
