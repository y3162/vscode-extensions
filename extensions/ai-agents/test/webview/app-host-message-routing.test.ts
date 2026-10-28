import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask', description: 'Questions' }],
    mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write', description: 'Default' }, { id: 'read-only', label: 'Read only' }],
    sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }],
    approval: 'never', showApproval: false, webSearchChoices: [{ id: '', label: 'Off' }, { id: 'live', label: 'Live' }],
    webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
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

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function key(node: HTMLElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new node.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
}

test('host messages show errors, inspectors, navigation, and probes without inventing commands', () => {
  const { window, sent, emit, document, app } = boot();
  emit(shell({ sessionTitle: 'Alpha', sessions: [{ id: 'a', title: 'Alpha', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' }] }), [
    { id: 'user', role: 'user', text: 'hi', at: 1 },
  ]);
  click(visible(document, '.new-chat'));
  window.dispatchEvent(new window.MessageEvent('message', { data: null }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { nope: true } }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'error', text: 'connection lost' } }));
  const alert = document.querySelector('.host-error') as HTMLElement;
  assert.equal(alert.hidden, false);
  assert.equal(alert.textContent, 'connection lost');
  assert.equal(posted(sent, 'send'), undefined);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'inspector', title: 'Diagnostics', text: 'all good' } }));
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  assert.equal(document.querySelector('.inspector h3')?.textContent, 'Diagnostics');
  assert.match(document.querySelector('.inspector pre')?.textContent ?? '', /all good/);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'chat' } }));
  assert.equal(alert.hidden, true);
  assert.equal(document.querySelector('.settings-panel')?.hidden, true);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'settings' } }));
  click(document.querySelector('.provider')!);
  key(document.body, 'Escape');
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  key(document.body, 'Escape');
  assert.equal(document.querySelector('.settings-panel')?.hidden, true);
  const before = countType(sent, 'refreshSessions');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'history' } }));
  assert.equal(document.getElementById('app')?.dataset.page, 'home');
  assert.equal(countType(sent, 'refreshSessions'), before + 1);
  const kept = [{ id: 'a', title: 'Alpha', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' as const }];
  const keptMessages = [{ id: 'user', role: 'user' as const, text: 'hi', at: 1 }];
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 2, full: true, shell: shell({ sessionTitle: 'First', sessions: kept }), messages: { removed: [], upserts: keptMessages, order: ['user'] } },
  }));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 3, full: true, shell: shell({ sessionTitle: 'Second', sessions: kept }), messages: { removed: [], upserts: keptMessages, order: ['user'] } },
  }));
  app.flush();
  assert.equal(document.querySelector('.title-pill')?.textContent, 'Second');
  click(visible(document, '[data-session-id="a"]'));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'probe' } }));
  const probe = posted(sent, 'probeResult');
  assert.equal(probe?.turns, 1);
  assert.equal(probe?.pending, false);
  assert.equal(probe?.history, false);
  assert.equal(probe?.settings, false);
  assert.equal('provider' in (probe ?? {}), false);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: 'missing', ok: true } }));
  assert.equal(posted(sent, 'copy'), undefined);
});
