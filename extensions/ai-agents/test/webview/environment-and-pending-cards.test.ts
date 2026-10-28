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

test('mode, environment, and pending cards post only the selected command', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }));
  click(visible(document, '.new-chat'));
  click(document.querySelector('.mode')!);
  assert.equal(document.querySelector('.menu')?.hidden, true);
  emit(shell());
  click(visible(document, '.mode'));
  assert.match(visible(document, '.menu-item[data-id="ask"]').textContent ?? '', /Questions/);
  click(visible(document, '.menu-item[data-id="ask"]'));
  assert.equal(posted(sent, 'configure')?.mode, 'ask');
  click(visible(document, '.env'));
  click(visible(document, '.menu-item[data-id="/other"]'));
  assert.equal(posted(sent, 'select')?.cwd, '/other');
  click(visible(document, '.env'));
  click(visible(document, '.menu-item[data-id="settings"]'));
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  emit(shell({
    permission: null,
    plan: { token: 'p', request: { id: 'plan', name: 'Ship', overview: 'Over', plan: '**Body**', todos: [] } },
  }));
  assert.match(document.querySelector('.pending .md')?.textContent ?? '', /Over/);
  assert.equal(document.querySelector('.pending .md strong')?.textContent, 'Body');
  click([...document.querySelectorAll('.pending button')].find((button) => button.textContent === 'Reject')!);
  assert.equal(posted(sent, 'resolvePlan')?.decision, 'rejected');
  assert.equal(posted(sent, 'resolveQuestion'), undefined);
  emit(shell({
    question: { token: 'q', request: { id: 'ask', title: '', questions: [{ id: 'free', prompt: 'Name', options: [] }] } },
  }));
  const text = document.querySelector('.pending input') as HTMLInputElement;
  text.value = 'Ada';
  click(document.querySelector('.pending button')!);
  assert.deepEqual(posted(sent, 'resolveQuestion')?.answers, { free: ['Ada'] });
  emit(shell({
    permission: { token: 'once', request: { id: 'perm', title: 'Run', detail: 'npm test', kind: 'shell' } },
  }));
  const allow = [...document.querySelectorAll('.pending button')].find((button) => button.textContent === 'Allow');
  const again = emit;
  again(shell({ permission: { token: 'once', request: { id: 'perm', title: 'Run', detail: 'npm test', kind: 'shell' } } }));
  assert.equal(document.querySelector('.pending button'), allow);
  emit(shell());
  assert.equal(document.querySelector('.pending')?.hidden, true);
  assert.equal(document.querySelector('.pending-card'), null);
});
