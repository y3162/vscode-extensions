import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

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

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function countType(sent: unknown[], type: string): number {
  return sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === type).length;
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

function windowNull(document: Document, sent: unknown[]): void {
  document.defaultView?.dispatchEvent(new document.defaultView.MessageEvent('message', {
    data: { type: 'state', revision: 9, full: false, shell: null, messages: { removed: [], upserts: [], order: [] } },
  }));
  void sent;
}

test('history shows activity, empty titles, and the conversation id that was clicked', () => {
  const { sent, emit, document } = boot();
  emit(shell({
    sessionId: 'current',
    presence: 'waiting',
    providers: [],
    provider: 'cursor',
    sessions: [
      { id: 'old', title: '', updatedAt: '2026-10-14T00:00:00.000Z', provider: 'codex', activity: 'idle' },
      { id: 'current', conversationId: 'conv-current', title: 'Current', updatedAt: '2026-10-15T00:00:00.000Z', provider: 'codex', activity: 'idle' },
      { id: 'live', conversationId: 'conv-live', title: 'Live', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex', activity: 'running' },
    ],
  }));
  assert.equal(document.querySelector('.provider .btn-label')?.textContent, 'Cursor');
  assert.deepEqual([...document.querySelectorAll('.session-name')].map((node) => node.textContent), ['Live', 'Current', 'old']);
  assert.match(document.querySelector('[data-session-id="live"] .presence')?.className ?? '', /running/);
  assert.match(document.querySelector('[data-session-id="current"] .presence')?.className ?? '', /waiting/);
  assert.equal(document.querySelector('[data-session-id="old"] .presence'), null);
  click(document.querySelector('[data-session-id="live"]')!);
  assert.equal(posted(sent, 'restoreSession')?.id, 'conv-live');
  emit(shell({
    provider: 'codex', providers: [], sessionId: 'same', presence: 'error',
    sessions: [{ id: 'same', title: 'Same', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' }],
  }));
  assert.equal(document.querySelector('.provider .btn-label')?.textContent, 'Codex');
  assert.equal(document.querySelector('[data-session-id="same"] .presence'), null);
  const before = countType(sent, 'restoreSession');
  emit(shell({
    sessionId: 'current', presence: 'running',
    sessions: [
      { id: 'current', title: 'Current', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' },
      { id: 'other', title: 'Other', updatedAt: '2026-10-15T00:00:00.000Z', provider: 'codex' },
    ],
  }));
  windowNull(document, sent);
  click(document.querySelector('[data-session-id="other"]')!);
  assert.equal(countType(sent, 'restoreSession'), before);
});
