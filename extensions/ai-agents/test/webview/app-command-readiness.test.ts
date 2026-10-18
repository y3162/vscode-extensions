import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
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

test('actions before the first shell do not post agent commands', () => {
  const { window, sent, document } = boot();
  for (const selector of ['.provider', '.mode', '.attach', '.env', '.open-terminals', '.send']) click(document.querySelector(selector)!);
  assert.equal(posted(sent, 'select'), undefined);
  assert.equal(posted(sent, 'configure'), undefined);
  assert.equal(posted(sent, 'attach'), undefined);
  assert.equal(posted(sent, 'openTerminal'), undefined);
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(document.querySelector('.menu')?.hidden, true);
  click(document.querySelector('.new-chat')!);
  const created = posted(sent, 'newChat');
  assert.equal(created?.type, 'newChat');
  assert.equal('provider' in (created ?? {}), false);
  assert.equal(document.getElementById('app')?.dataset.page, 'chat');
  assert.equal(window.document.querySelector('#prompt'), document.activeElement);
});
