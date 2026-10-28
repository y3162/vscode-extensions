import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ModelCatalogMessage, ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'front',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function bootApp(saved?: unknown) {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  let persisted = saved ?? null;
  const sent: unknown[] = [];
  const vscode: VsCodeApi = {
    postMessage(message) { sent.push(message); },
    getState: () => persisted,
    setState(state) { persisted = state; },
  };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, diff: { removed?: string[]; upserts?: ViewMessage[]; order?: string[]; full?: boolean } = {}) => {
    const upserts = diff.upserts ?? [];
    window.dispatchEvent(new window.MessageEvent('message', { data: {
      type: 'state', revision: 1, full: diff.full ?? true, shell: next,
      messages: { removed: diff.removed ?? [], upserts, order: diff.order ?? upserts.map((message) => message.id) },
    } }));
    app.flush();
  };
  return { window, sent, app, document: window.document, emit };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

test('app falls back to body without #app, drops removed IDs, and skips dangling message order IDs', () => {
  const detached = new Window();
  const emptySent: unknown[] = [];
  const emptyApp = createApp({
    postMessage(message) { emptySent.push(message); }, getState: () => null, setState() {},
  }, { document: detached.document });
  assert.equal(detached.document.body.classList.contains('shell'), true);
  assert.equal(posted(emptySent, 'ready')?.type, 'ready');
  emptyApp.destroy();

  const { window, document, app, emit } = bootApp();
  const user = { id: 'user-1', role: 'user' as const, text: 'visible prompt', at: 1 };
  emit(shell(), { upserts: [user], order: ['user-1'] });
  assert.equal(document.querySelector('[data-id="user-1"]')?.textContent?.includes('visible prompt'), true);
  emit(shell(), { full: false, removed: ['user-1'], order: ['stale-id'] });
  assert.equal(document.querySelector('[data-id="user-1"]'), null);
  assert.equal(document.querySelector('.turn'), null);
  assert.ok(document.querySelector('.empty'));
  app.destroy();
  window.happyDOM.abort();
});
