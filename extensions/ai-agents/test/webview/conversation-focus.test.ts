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


test('completed activity can be expanded, stays expanded on updates, and closes explicitly', () => {
  const { window, document, emit } = boot({ page: 'chat' });
  const messages: ViewMessage[] = [{ id: 'u', role: 'user', text: 'Run tests', at: 1 }, { id: 't', role: 'tool', text: 'done', at: 2, tool: { kind: 'shell', name: 'command', status: 'completed', target: 'npm test' } }, { id: 'a', role: 'assistant', text: 'Tests passed', at: 3, final: true }];
  emit(shell(), messages);
  const log = document.querySelector<HTMLElement>('.log')!;
  const toggle = document.querySelector<HTMLButtonElement>('.log-toggle')!;
  assert.equal(log.hidden, true);
  toggle.click();
  assert.equal(log.hidden, false);
  emit(shell({ statusText: 'Updated' }), messages);
  assert.equal(log.hidden, false);
  toggle.click();
  assert.equal(log.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  window.happyDOM.abort();
});

test('changed-file disclosure keeps diff and restore actions scoped and labeled', () => {
  const { window, document, sent, emit } = boot({ page: 'chat' });
  const next = shell({ folders: [{ name: 'workspace', path: '/workspace' }], changes: [{ name: 'long-name.ts', path: '/workspace/src/long-name.ts', kind: 'update', additions: 2, deletions: 1, canDiff: true, canRevert: true, synthetic: false }] });
  emit(next);
  assert.equal(document.querySelector<HTMLElement>('.change-items')!.hidden, true);
  const toggle = document.querySelector<HTMLButtonElement>('.change-toggle')!;
  toggle.click();
  assert.equal(document.querySelector<HTMLElement>('.change-items')!.hidden, false);
  toggle.focus();
  emit(next);
  assert.equal(document.activeElement, toggle);
  assert.equal(document.querySelector<HTMLElement>('.change-items')!.hidden, false);
  const file = document.querySelector<HTMLButtonElement>('.change-file .file-link')!;
  assert.equal(file.title, '/workspace/src/long-name.ts');
  file.click();
  assert.equal(posted(sent, 'openDiff')?.path, '/workspace/src/long-name.ts');
  assert.equal(posted(sent, 'openDiff')?.conversationId, 'front');
  const revert = document.querySelector<HTMLButtonElement>('.change-file .ghost')!;
  assert.match(revert.getAttribute('aria-label')!, /long-name.ts/);
  revert.click();
  assert.equal(posted(sent, 'revertFile')?.path, '/workspace/src/long-name.ts');
  assert.equal(document.querySelector<HTMLElement>('.env')!.hidden, false);
  assert.match(document.querySelector('.access-label')!.textContent!, /Workspace write/);
  window.happyDOM.abort();
});

test('settings preserves focus across unrelated updates and returns to its trigger', () => {
  const { window, document, emit } = boot({ page: 'chat' });
  emit(shell());
  const trigger = document.querySelector<HTMLButtonElement>('.access-label')!;
  trigger.focus(); trigger.click();
  const select = document.querySelector<HTMLSelectElement>('select[data-key="sandbox"]')!;
  select.focus();
  emit(shell({ statusText: 'Working' }));
  assert.equal(document.activeElement, select);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector<HTMLElement>('.settings-panel')!.hidden, true);
  assert.equal(document.activeElement, trigger);
  window.happyDOM.abort();
});

test('Home exposes state and time and offers a new chat without losing provider limits', () => {
  const { window, document, emit, sent } = boot();
  emit(shell({ busy: true, presence: 'running', sessions: [{ id: 'one', title: 'A long session title', provider: 'codex', cwd: '/workspace', updatedAt: '2026-10-28T06:00:00Z', activity: 'running' }] }));
  assert.match(document.querySelector('.session-card')!.getAttribute('aria-label')!, /Running/);
  emit(shell({ sessions: [{ id: 'one', title: 'Waiting session', provider: 'codex', cwd: '/workspace', updatedAt: '2026-10-28T06:00:00Z', activity: 'waiting' }] }));
  assert.match(document.querySelector('.session-card')!.getAttribute('aria-label')!, /Waiting/);
  assert.equal(document.querySelector('time')!.getAttribute('datetime'), '2026-10-28T06:00:00Z');
  emit(shell({ busy: true }));
  assert.equal(document.querySelector<HTMLButtonElement>('.provider')!.disabled, true);
  document.querySelector<HTMLButtonElement>('.home-start')!.click();
  assert.equal(posted(sent, 'newChat')?.type, 'newChat');
  assert.equal(document.querySelector<HTMLElement>('.dock')!.hidden, false);
  window.happyDOM.abort();
});

test('a finished turn keeps the user request at the end of its row and leaves tool failures outside the collapsed log', () => {
  const { window, document, emit } = boot({ page: 'chat' });
  emit(shell({ presence: 'running', statusText: 'Working' }), [
    { id: 'user', role: 'user', text: 'Hi', at: 1 },
    { id: 'tool', role: 'tool', text: 'nope', at: 2, tool: { name: 'search', kind: 'search', status: 'error' } },
    { id: 'answer', role: 'assistant', text: 'Stopped.', at: 3, final: true },
  ]);
  const row = document.querySelector('.user-row')!;
  assert.equal(row.nextElementSibling?.classList.contains('assistant'), true);
  assert.equal(document.querySelector('.log')?.hasAttribute('hidden') || (document.querySelector('.log') as HTMLElement).hidden, true);
  assert.match(document.querySelector('.tool-failures')?.textContent ?? '', /search: nope/);
  assert.equal(document.querySelector('.open-terminals'), null);
  assert.equal(document.querySelector('.chat-title .presence.running')?.hasAttribute('hidden'), false);
  window.happyDOM.abort();
});
