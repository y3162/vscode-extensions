import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import { strings } from '../../src/webview/strings.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask', description: 'Questions' }],
    mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write', description: 'Default' }, { id: 'read-only', label: 'Read only' }],
    sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }],
    approval: 'never', showApproval: false, webSearchChoices: [{ id: '', label: 'Off' }, { id: 'live', label: 'Live' }],
    webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backendChoices: [{ id: 'sdk', label: 'SDK' }, { id: 'app-server', label: 'App Server' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function boot(saved?: unknown) {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  let persisted: unknown = saved ?? null;
  const vscode: VsCodeApi = {
    postMessage(message) { sent.push(message); },
    getState: () => persisted,
    setState(state) { persisted = state; },
  };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  const input = () => window.document.querySelector('#prompt') as HTMLTextAreaElement;
  return { window, sent, app, emit, persisted: () => persisted, input, document: window.document };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('a restored webview keeps the draft, the open log, and an unstuck thread', () => {
  const imageDraftKey = ['codex', '/workspace', 'front', '', 'sdk'].join('\0');
  const { window, emit, document, input } = boot({
    draft: 'saved draft',
    attachmentDrafts: { [imageDraftKey]: { images: [{ mimeType: 'image/png', data: 'aW1hZ2U=', name: 'fixture.png' }], chips: [] } },
    expanded: ['user'], stick: false, page: 'chat',
  });
  const thread = document.querySelector('.thread') as HTMLElement;
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(thread, 'scrollTop', { configurable: true, writable: true, value: 0 });
  emit(shell({ locale: 'ja', sessionTitle: '保存済み' }), [
    { id: 'user', role: 'user', text: '質問', at: 1 },
    { id: 'note', role: 'status', text: 'メモ', at: 2, turnId: 'user' },
    { id: 'answer', role: 'assistant', text: '答え', at: 3, turnId: 'user', final: true },
  ]);
  assert.equal(document.getElementById('app')?.dataset.page, 'chat');
  assert.equal(input().value, 'saved draft');
  assert.equal(document.querySelector('.chips img')?.getAttribute('alt'), 'fixture.png');
  assert.equal(input().placeholder, strings('ja').placeholder);
  assert.equal(document.documentElement.lang, 'ja');
  assert.equal(document.querySelector('.log')?.hidden, false);
  const jump = document.querySelector('.jump') as HTMLElement;
  assert.equal(jump.hidden, false);
  thread.dispatchEvent(new window.Event('scroll'));
  assert.equal(jump.hidden, false);
  click(jump);
  assert.equal(jump.hidden, true);
  assert.equal(thread.scrollTop, 1000);
});
