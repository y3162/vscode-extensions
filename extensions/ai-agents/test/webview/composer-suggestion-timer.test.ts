import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewShell } from '../../src/protocol.js';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'Chat', modelLabel: 'Model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [], modes: [{ id: 'agent', label: 'Agent' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'conversation',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function bootComposer() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  return { window, host, composer, sent };
}

test('composer defaults a missing caret to position zero and discards an already-queued stale suggestion callback', async () => {
  const { window, host, composer, sent } = bootComposer();
  composer.render(shell(), strings('en'));
  const input = host.querySelector<HTMLTextAreaElement>('#prompt')!;
  Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
  input.value = '@file';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  assert.equal(sent.some((message) => (message as { type?: string }).type === 'suggest'), false, 'caret zero is before the @ token');

  const clear = window.clearTimeout.bind(window);
  window.clearTimeout = (() => undefined) as typeof window.clearTimeout;
  try {
    Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => input.value.length });
    input.value = '@queued';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    composer.draft = 'new prompt';
    await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  } finally {
    window.clearTimeout = clear;
  }
  assert.equal(sent.some((message) => (message as { type?: string }).type === 'suggest'), false, 'an expired request ID cannot publish after its token is cleared');
  window.happyDOM.abort();
});
