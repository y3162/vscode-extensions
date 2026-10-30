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

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('Enter sends, Shift+Enter keeps the prompt open for a newline, and IME confirmation does not send', async () => {
  const { window, sent, input, emit } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  const prompt = input();
  prompt.value = 'hello';
  const newline = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
  prompt.dispatchEvent(newline);
  assert.equal(newline.defaultPrevented, false);
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(prompt.value, 'hello');
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(posted(sent, 'send')?.prompt, 'hello');
  assert.equal(prompt.value, '');
  prompt.value = '日本語の入力';
  prompt.dispatchEvent(new window.Event('compositionstart'));
  const composing = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(composing);
  prompt.dispatchEvent(new window.Event('compositionend'));
  assert.equal(composing.defaultPrevented, false);
  assert.equal(posted(sent, 'send')?.prompt, 'hello');
  assert.equal(prompt.value, '日本語の入力');
  const confirmed = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(confirmed);
  assert.equal(confirmed.defaultPrevented, true, 'Enter delivered immediately after compositionend is not submitted');
  assert.equal(posted(sent, 'send')?.prompt, 'hello');
  await new Promise((resolve) => setTimeout(resolve, 110));
  const sendJapanese = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(sendJapanese);
  assert.equal(sendJapanese.defaultPrevented, true);
  assert.equal(posted(sent, 'send')?.prompt, '日本語の入力');
  assert.equal(prompt.value, '');
  const imeKey = new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
  prompt.dispatchEvent(imeKey);
  assert.equal(imeKey.defaultPrevented, false);
  const submit = new window.Event('submit', { bubbles: true, cancelable: true });
  window.document.querySelector('form')!.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(sent.filter((message) => (message as { type: string }).type === 'send').length, 2);
  prompt.value = 'こんにちは\n続きのメッセージ';
  click(visible(window.document, '.send'));
  assert.deepEqual(posted(sent, 'send'), {
    provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'send', prompt: 'こんにちは\n続きのメッセージ', images: [],
  });
  assert.equal(sent.filter((message) => (message as { type: string }).type === 'send').length, 3);
  assert.equal(prompt.value, '');
});

test('a running turn queues, ArrowUp recalls, and approval answers keep their token', () => {
  const { window, sent, input, emit } = mount();
  const messages: ViewMessage[] = [{ id: 'user', role: 'user', text: 'previous prompt', at: 1 }, { id: 'answer', role: 'assistant', text: 'ok', at: 2 }];
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), messages);
  const prompt = input();
  prompt.value = '';
  prompt.selectionStart = 0;
  prompt.selectionEnd = 0;
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(prompt.value, 'previous prompt');
  prompt.value = 'follow up';
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(posted(sent, 'enqueue')?.prompt, 'follow up');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'chat' } }));
  assert.equal(prompt.value, '');
  assert.equal(posted(sent, 'enqueue')?.prompt, 'follow up');
  emit(shell({
    permission: { token: 'token-1', request: { id: 'perm', title: 'Run npm test', detail: 'npm test', kind: 'shell' } },
    presence: 'waiting', statusText: 'Waiting',
  }));
  const allow = [...window.document.querySelectorAll('button')].find((button) => button.textContent?.includes('Allow') && !button.textContent?.includes('session'));
  allow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const answer = posted(sent, 'resolvePermission');
  assert.equal(answer?.id, 'perm');
  assert.equal(answer?.token, 'token-1');
  assert.equal(answer?.decision, 'allow-once');
  const choices = [...window.document.querySelectorAll<HTMLButtonElement>('.pending-card .card-actions button')];
  assert.equal(choices.every((button) => button.disabled), true);
  choices[2]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.filter((message) => message.type === 'resolvePermission').length, 1);
});

test('suggestion arrows and Tab insert the highlighted file', async () => {
  const { window, sent, input, emit } = mount();
  emit(shell());
  const prompt = input();
  prompt.value = '@re';
  prompt.selectionStart = 3;
  prompt.selectionEnd = 3;
  prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const request = posted(sent, 'suggest');
  assert.equal(request?.query, 're');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'suggestions', requestId: request?.requestId, items: [
        { label: 'readme', token: 'readme.md', description: '.' },
        { label: 'review', token: 'review.ts', description: 'src' },
      ],
    },
  }));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(prompt.value, '@re');
  prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const again = posted(sent, 'suggest');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: again?.requestId, items: [
      { label: 'readme', token: 'readme.md' },
      { label: 'review', token: 'review.ts' },
    ] },
  }));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(prompt.value, '@review.ts ');
});

test('a question card submits every answer together', () => {
  const { window, sent, emit } = mount();
  emit(shell({
    question: {
      token: 'q-token',
      request: {
        id: 'ask', title: 'Choose',
        questions: [
          { id: 'q1', prompt: 'First?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          { id: 'q2', prompt: 'Second?', options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }], allowMultiple: true },
        ],
      },
    },
  }));
  const boxes = [...window.document.querySelectorAll('input')] as HTMLInputElement[];
  const pick = (value: string) => { const input = boxes.find((item) => item.value === value); if (input) input.checked = true; };
  pick('a');
  pick('c');
  pick('d');
  [...window.document.querySelectorAll('button')].find((button) => button.textContent?.includes('Submit'))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(posted(sent, 'resolveQuestion')?.answers, { q1: ['a'], q2: ['c', 'd'] });
  assert.equal(posted(sent, 'resolveQuestion')?.token, 'q-token');
});

test('suggestion insertion and attachment removal persist the visible draft', async () => {
  const { window, sent, emit, input, persisted } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  input().value = '@read';
  input().selectionStart = input().selectionEnd = 5;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const request = posted(sent, 'suggest')!;
  window.dispatchEvent(new window.MessageEvent('message', { data: {
    type: 'suggestions', requestId: request.requestId, items: [{ label: 'README', token: 'README.md' }],
  } }));
  input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(input().value, '@README.md ');
  assert.equal(persisted().draft, input().value);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'insert', text: 'file content', label: 'file.ts' } }));
  click(window.document.querySelector('.composer-card .chip button')!);
  assert.equal(input().value.includes('file content'), false);
  assert.equal(persisted().draft, input().value);
});

test('late suggestions cannot reopen after removing a token, sending, or switching conversations', async () => {
  const { window, sent, emit, input } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  for (const dismiss of ['edit', 'send', 'switch']) {
    input().value = '@file';
    input().selectionStart = input().selectionEnd = 5;
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const request = posted(sent, 'suggest')!;
    if (dismiss === 'edit') {
      input().value = 'plain draft';
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    } else if (dismiss === 'send') click(visible(window.document, '.send'));
    else emit(shell({ conversationId: 'other' }));
    window.dispatchEvent(new window.MessageEvent('message', { data: {
      type: 'suggestions', requestId: request.requestId, items: [{ label: 'old file', token: 'old.ts' }],
    } }));
    assert.equal(window.document.querySelector('.suggest')?.hidden, true, dismiss);
    assert.equal(input().getAttribute('aria-expanded'), 'false', dismiss);
  }
});
