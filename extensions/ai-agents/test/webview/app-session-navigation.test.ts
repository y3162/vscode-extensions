import assert from 'node:assert/strict';

import path from 'node:path';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backend: 'cli',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function mount() {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  let persisted: unknown;
  const vscode: VsCodeApi = { postMessage(message) { sent.push(message); }, getState: () => null, setState(state) { persisted = state; } };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  return { window, sent, app, emit, persisted: () => persisted as { draft?: string }, input: () => window.document.querySelector('textarea') as HTMLTextAreaElement };
}

const sampleSessions = [
  { id: 'a', title: 'Alpha', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' as const },
  { id: 'b', title: 'Beta', updatedAt: '2026-10-15T00:00:00.000Z', provider: 'codex' as const },
  { id: 'c', title: 'OpenCVライブラリの依存関係をかなり長いタイトルで確認する', updatedAt: '2026-10-14T00:00:00.000Z', provider: 'codex' as const },
];

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('home lists the current provider and opens chat without restoring the active session', () => {
  const { window, sent, emit } = mount();
  emit(shell({
    sessionId: 'a', sessionTitle: 'Alpha',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }, { id: 'cursor', label: 'Cursor', detail: 'ACP' }],
    sessions: sampleSessions,
  }));
  const root = window.document.getElementById('app');
  assert.equal(root?.dataset.page, 'home');
  assert.equal(window.document.querySelector('.dock')?.hidden, true);
  assert.equal(window.document.querySelector('.provider .btn-label')?.textContent, 'Codex');
  assert.deepEqual(
    [...window.document.querySelectorAll('.session-card .session-name')].map((node) => node.textContent),
    sampleSessions.map((session) => session.title),
  );
  const long = window.document.querySelector<HTMLElement>('[data-session-id="c"]');
  assert.equal(long?.title, sampleSessions[2]?.title);
  click(visible(window.document, '.provider'));
  click(visible(window.document, '.menu-item[data-id="cursor"]'));
  assert.equal(posted(sent, 'select')?.provider, 'cursor');
  assert.equal(root?.dataset.page, 'home');
  click(visible(window.document, '[data-session-id="a"]'));
  assert.equal(posted(sent, 'restoreSession'), undefined);
  assert.equal(root?.dataset.page, 'chat');
  assert.equal(window.document.querySelector('.title-pill')?.textContent, 'Alpha');
  click(visible(window.document, '.back'));
  assert.equal(posted(sent, 'stop'), undefined);
  assert.equal(posted(sent, 'newChat'), undefined);
  assert.equal(root?.dataset.page, 'home');
  click(visible(window.document, '[data-session-id="b"]'));
  assert.equal(posted(sent, 'restoreSession')?.id, 'b');
  assert.equal(root?.dataset.page, 'chat');
});

test('a new chat opens the composer and settings stay on the current page', () => {
  const { window, sent, input, emit } = mount();
  emit(shell({ sessions: [] }));
  assert.match(window.document.querySelector('.empty-home')?.textContent ?? '', /No conversations yet/);
  assert.equal(window.document.querySelector('.session-card'), null);
  click(visible(window.document, '.new-chat'));
  assert.ok(posted(sent, 'newChat'));
  assert.equal(window.document.getElementById('app')?.dataset.page, 'chat');
  assert.equal(input().placeholder, 'Plan, ask, / for commands, @ for context');
  click(visible(window.document, '.mode'));
  assert.match(visible(window.document, '.menu-item[data-id="agent"]').textContent ?? '', /∞/);
  click(visible(window.document, '.menu-item[data-id="plan"]'));
  assert.equal(posted(sent, 'configure')?.mode, 'plan');
  click(visible(window.document, '.model-name'));
  assert.ok(posted(sent, 'loadModelCatalog'));
  assert.equal(window.document.querySelector('.model-menu')?.hidden, false);
  assert.match(window.document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);
  assert.equal(posted(sent, 'chooseModel'), undefined);
  assert.match(window.document.querySelector('.model-name')?.textContent ?? '', /gpt High/);
  emit(shell({ sessions: [], effortLabel: null, modelSettings: 'unsupported' }));
  click(visible(window.document, '.model-name'));
  assert.equal(window.document.querySelector('.model-name')?.classList.contains('is-static'), true);
  assert.equal(window.document.querySelector('.model-menu')?.hidden, true);
  click(visible(window.document, '.open-settings'));
  const sheet = window.document.querySelector('.settings-panel');
  assert.equal(sheet?.hidden, false);
  assert.match(sheet?.textContent ?? '', /Sign in/);
  assert.match(sheet?.textContent ?? '', /Diagnose/);
  [...window.document.querySelectorAll('button')].find((button) => button.textContent?.includes('Close'))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.document.querySelector('.settings-panel')?.hidden, true);
  assert.equal(window.document.getElementById('app')?.dataset.page, 'chat');
});

test('mode and model keep their quick picks, and a run survives leaving chat', () => {
  const { window, sent, input, emit, app } = mount();
  const messages: ViewMessage[] = [{ id: 'user', role: 'user', text: 'alpha', at: 1 }];
  emit(shell({
    sessionId: 'a', sessionTitle: 'Alpha', busy: true, presence: 'running', statusText: 'Running',
    queue: [{ id: 'q1', text: 'queued follow-up', images: 0 }],
    sessions: sampleSessions,
  }), messages);
  const root = window.document.getElementById('app');
  assert.ok(window.document.querySelector('[data-session-id="a"] .presence.running'));
  assert.equal(window.document.querySelector('[data-session-id="b"] .presence'), null);
  click(visible(window.document, '[data-session-id="b"]'));
  assert.equal(posted(sent, 'stop'), undefined);
  assert.deepEqual(posted(sent, 'restoreSession'), { provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'restoreSession', id: 'b' });
  assert.equal(root?.dataset.page, 'chat');
  click(visible(window.document, '.back'));
  assert.equal(posted(sent, 'stop'), undefined);
  click(visible(window.document, '[data-session-id="a"]'));
  assert.equal(posted(sent, 'stop'), undefined);
  assert.equal(root?.dataset.page, 'chat');
  assert.match(window.document.querySelector('.thread')?.textContent ?? '', /alpha/);
  assert.match(window.document.querySelector('.queue')?.textContent ?? '', /queued follow-up/);
  input().value = 'keep this draft';
  click(visible(window.document, '.back'));
  assert.equal(posted(sent, 'stop'), undefined);
  assert.equal(root?.dataset.page, 'home');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'state', revision: 2, full: false,
      shell: shell({
        sessionId: 'a', sessionTitle: 'Alpha', busy: true, presence: 'running', statusText: 'Running',
        queue: [{ id: 'q1', text: 'queued follow-up', images: 0 }],
        sessions: sampleSessions,
      }),
      messages: { removed: [], upserts: [{ id: 'answer', role: 'assistant', text: 'beta', at: 2 }], order: ['user', 'answer'] },
    },
  }));
  app.flush();
  click(visible(window.document, '[data-session-id="a"]'));
  assert.match(window.document.querySelector('.thread')?.textContent ?? '', /alpha/);
  assert.match(window.document.querySelector('.thread')?.textContent ?? '', /beta/);
  assert.equal(input().value, 'keep this draft');
  emit(shell({
    sessionId: 'b', sessionTitle: 'Beta', sessions: sampleSessions,
  }), [{ id: 'other', role: 'user', text: 'gamma', at: 3 }]);
  assert.match(window.document.querySelector('.thread')?.textContent ?? '', /gamma/);
  assert.doesNotMatch(window.document.querySelector('.thread')?.textContent ?? '', /alpha/);
});

test('a recreated webview restores the chat page', () => {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  let persisted: unknown = null;
  const sent: unknown[] = [];
  const vscode: VsCodeApi = {
    postMessage(message) { sent.push(message); },
    getState: () => persisted,
    setState(state) { persisted = state; },
  };
  const first = createApp(vscode, { document: window.document });
  const messages: ViewMessage[] = [{ id: 'user', role: 'user', text: 'alpha', at: 1 }];
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 1, full: true, shell: shell({ sessionId: 'a', sessionTitle: 'Alpha', sessions: sampleSessions }), messages: { removed: [], upserts: messages, order: ['user'] } },
  }));
  first.flush();
  click(visible(window.document, '[data-session-id="a"]'));
  assert.equal((persisted as { page?: string }).page, 'chat');
  first.destroy();
  window.document.body.innerHTML = '<div id="app"></div>';
  const second = createApp(vscode, { document: window.document });
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 1, full: true, shell: shell({ sessionId: 'a', sessionTitle: 'Alpha', sessions: sampleSessions }), messages: { removed: [], upserts: messages, order: ['user'] } },
  }));
  second.flush();
  assert.equal(window.document.getElementById('app')?.dataset.page, 'chat');
  assert.match(window.document.querySelector('.thread')?.textContent ?? '', /alpha/);
  assert.equal(window.document.querySelector('.back')?.hidden, false);
  second.destroy();
});

test('sending persists the cleared draft and a new conversation forgets prompt recall', () => {
  const window = new Window();
  window.document.body.innerHTML = '<div id="app"></div>';
  let persisted: { draft?: string } = {};
  const app = createApp({ postMessage() {}, getState: () => null, setState(state) { persisted = state as typeof persisted; } }, { document: window.document });
  const emit = (messages: ViewMessage[]) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: {
      type: 'state', full: true, shell: shell(), messages: { removed: [], upserts: messages, order: messages.map((item) => item.id) },
    } }));
    app.flush();
  };
  emit([{ id: 'old', role: 'user', text: 'prior conversation', at: 1 }]);
  click(visible(window.document, '.new-chat'));
  const input = window.document.querySelector('textarea')!;
  input.value = 'send me';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(persisted.draft, 'send me');
  click(visible(window.document, '.send'));
  assert.equal(persisted.draft, '');
  emit([]);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(input.value, '');
  app.destroy();
});

test('history selection restores that conversation', () => {
  const { window, sent, emit } = mount();
  emit(shell({
    sessionId: 'current',
    sessions: [
      { id: 'current', conversationId: 'current', title: 'Current', updatedAt: '2026-01-02T00:00:00.000Z', provider: 'codex', cwd: '/workspace' },
      { id: 'earlier', conversationId: 'earlier', title: 'Earlier chat', updatedAt: '2026-01-01T00:00:00.000Z', provider: 'codex', cwd: '/workspace' },
    ],
  }));
  click(visible(window.document, '[data-session-id="earlier"]'));
  assert.equal(posted(sent, 'restoreSession')?.id, 'earlier');
  assert.equal(window.document.getElementById('app')?.dataset.page, 'chat');
});
