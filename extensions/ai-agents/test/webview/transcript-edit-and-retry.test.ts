import assert from 'node:assert/strict';

import path from 'node:path';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import { createDom } from '../../src/webview/dom.js';

import { Transcript } from '../../src/webview/transcript.js';

import { strings } from '../../src/webview/strings.js';

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

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('message editing opens inline, preserves attachments, and Cancel restores the original prompt', () => {
  const { window, sent, emit, input } = mount();
  const original = '日本語の質問\n二行目';
  emit(shell(), [
    { id: 'u', role: 'user', text: original, attachments: ['src/notes.md'], at: 1, canRewind: true },
    { id: 'a', role: 'assistant', text: 'Answer', final: true, at: 2 },
  ]);
  click(visible(window.document, '.new-chat'));
  input().value = 'draft';
  click(window.document.querySelector('.user-row > .message-actions > .edit-user')!);
  const editor = window.document.querySelector<HTMLTextAreaElement>('.edit-prompt');
  assert.equal(editor?.value, original);
  assert.equal(window.document.activeElement, editor);
  assert.equal(window.document.querySelector('.edit-attachments')?.textContent, 'src/notes.md');
  assert.equal(window.document.querySelector<HTMLTextAreaElement>('.composer-card textarea')?.value, 'draft');
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(posted(sent, 'prepareRetry'), undefined);
  click(window.document.querySelector('[data-action="cancel-edit"]')!);
  assert.equal(window.document.querySelector('.edit-prompt'), null);
  assert.equal(window.document.querySelector('.bubble')?.textContent, `${original}src/notes.md`);
  assert.equal(posted(sent, 'send'), undefined);
});

test('Resend calls onRewind with the edited text and original turn id', () => {
  const window = new Window();
  const root = window.document.createElement('main');
  window.document.body.append(root);
  const calls: Array<[string, string]> = [];
  const transcript = new Transcript(createDom(window.document), root, () => {}, () => {}, () => {}, (turnId, text) => calls.push([turnId, text]));
  const messages: ViewMessage[] = [{ id: 'prompt-7', role: 'user', text: 'First draft', attachments: ['spec.md'], at: 1, canRewind: true }];
  transcript.render(messages, shell(), strings('en'));
  click(root.querySelector('.edit-user')!);
  const editor = root.querySelector<HTMLTextAreaElement>('.edit-prompt')!;
  editor.value = 'Revised prompt';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  transcript.render(messages, shell(), strings('en'));
  assert.equal(root.querySelector<HTMLTextAreaElement>('.edit-prompt'), editor);
  click(root.querySelector('[data-action="rewind"]')!);
  assert.deepEqual(calls, [['prompt-7', 'Revised prompt']]);
  assert.equal(root.querySelector('.prompt-editor'), null);
});

test('a completed Cursor message can be prepared as a new send without rewind', () => {
  const { window, sent, emit, input } = mount();
  emit(shell({ provider: 'cursor', providerLabel: 'Cursor · CLI' }), [
    { id: 'old-user', role: 'user', text: 'Run this again', at: 1, canRewind: false },
    { id: 'old-answer', role: 'assistant', text: 'Done', final: true, at: 2 },
  ]);
  click(visible(window.document, '.new-chat'));
  const resend = window.document.querySelector<HTMLButtonElement>('.resend-user')!;
  assert.equal(resend.disabled, false);
  click(resend);
  assert.equal(input().value, 'Run this again');
  assert.equal(posted(sent, 'prepareResend')?.id, 'old-user');
  assert.equal(posted(sent, 'rewind'), undefined);
  assert.equal(posted(sent, 'send'), undefined);
});

test('an image-only failed turn restores its original image for explicit Retry', () => {
  const { window, sent, emit, input } = mount();
  emit(shell(), [
    { id: 'image-turn', role: 'user', text: '', attachments: ['image.png'], at: 1 },
    { id: 'failed', role: 'error', text: 'Disconnected', at: 2 },
  ]);
  click(visible(window.document, '.new-chat'));
  const retry = window.document.querySelector('[data-action="retry"]')!;
  assert.match(retry.getAttribute('title') ?? '', /取り消されません/);
  click(retry);
  assert.equal(posted(sent, 'prepareRetry')?.id, 'image-turn');
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(window.document.activeElement, input());
  const image = { mimeType: 'image/png', data: 'aW1hZ2U=', name: 'image.png' };
  window.dispatchEvent(new window.MessageEvent('message', { data: {
    type: 'retryPrepared', id: 'image-turn', text: '', images: [image], attachments: ['image.png'],
    provider: 'codex', cwd: '/workspace', conversationId: 'front',
  } }));
  assert.equal(window.document.querySelectorAll('.composer-card .thumb').length, 1);
  assert.equal(window.document.querySelectorAll('.composer-card .chip').length, 1);
  click(visible(window.document, '.send'));
  assert.deepEqual(posted(sent, 'send')?.images, [image]);
  assert.deepEqual(posted(sent, 'send')?.attachments, ['image.png']);
  assert.equal(posted(sent, 'send')?.prompt, '');
  assert.equal(window.document.querySelectorAll('.composer-card .thumb').length, 0);
});

test('delayed Retry image restoration cannot overwrite typing or another conversation', () => {
  const { window, sent, emit, input } = mount();
  const messages: ViewMessage[] = [
    { id: 'image-turn', role: 'user', text: '', attachments: ['image.png'], at: 1 },
    { id: 'failed', role: 'error', text: 'Disconnected', at: 2 },
  ];
  emit(shell(), messages);
  click(visible(window.document, '.new-chat'));
  const deliver = () => window.dispatchEvent(new window.MessageEvent('message', { data: {
    type: 'retryPrepared', id: 'image-turn', text: '', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=', name: 'image.png' }],
    provider: 'codex', cwd: '/workspace', conversationId: 'front',
  } }));
  click(window.document.querySelector('[data-action="retry"]')!);
  input().value = 'new draft';
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  deliver();
  assert.equal(input().value, 'new draft');
  assert.equal(window.document.querySelectorAll('.composer-card .thumb').length, 0);
  click(window.document.querySelector('[data-action="retry"]')!);
  emit(shell({ conversationId: 'other' }));
  deliver();
  assert.equal(window.document.querySelectorAll('.composer-card .thumb').length, 0);
  assert.equal(posted(sent, 'send'), undefined);
});
