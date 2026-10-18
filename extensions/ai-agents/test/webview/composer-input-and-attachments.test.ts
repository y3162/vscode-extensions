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

test('the composer attaches, suggests, inserts, and refuses empty or cross-talk sends', async () => {
  const { window, sent, emit, input, document, persisted } = boot();
  emit(shell({ conversationId: '' }));
  click(visible(document, '.new-chat'));
  click(visible(document, '.attach'));
  const file = document.querySelector('input[type="file"]') as HTMLInputElement;
  let opened = 0;
  file.click = () => { opened += 1; };
  click(visible(document, '.menu-item[data-id="image"]'));
  assert.equal(opened, 1);
  assert.equal(posted(sent, 'attach'), undefined);
  for (const [id, kind] of [['file', 'file'], ['selection', 'selection'], ['problems', 'problems'], ['git', 'git'], ['terminal', 'terminal']] as const) {
    click(visible(document, '.attach'));
    click(visible(document, `.menu-item[data-id="${id}"]`));
    assert.equal(posted(sent, 'attach')?.kind, kind);
  }
  const png = new window.File(['hi'], 'shot.png', { type: 'image/png' });
  const jpg = new window.File(['hi'], 'shot.jpg', { type: 'image/jpg' });
  const gif = new window.File(['hi'], 'shot.gif', { type: 'image/gif' });
  const webp = new window.File(['hi'], 'shot.webp', { type: 'image/webp' });
  const svg = new window.File(['hi'], 'shot.svg', { type: 'image/svg+xml' });
  const huge = new window.File([new Uint8Array(5_000_001)], 'big.png', { type: 'image/png' });
  const list = new window.DataTransfer();
  for (const item of [png, jpg, gif, webp, svg, huge]) list.items.add(item);
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = window.FileReader;
  file.files = list.files;
  file.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelectorAll('.thumb').length, 4);
  assert.match(document.querySelector('.thumb')?.getAttribute('src') ?? '', /^data:image\/png/);
  const paste = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new window.DataTransfer() });
  input().dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  const imagePaste = new window.DataTransfer();
  imagePaste.items.add(png);
  const pasted = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: imagePaste });
  input().dispatchEvent(pasted);
  assert.equal(pasted.defaultPrevented, true);
  while (document.querySelector('.thumb')) click(document.querySelector('.thumb')!.parentElement!.querySelector('button')!);
  assert.equal(document.querySelector('.thumb'), null);
  assert.equal(posted(sent, 'send'), undefined);
  input().value = 'keep';
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'insert', text: 'body', label: 'file.ts' } }));
  assert.equal(input().value, 'keep\nbody');
  assert.match(document.querySelector('.chip')?.textContent ?? '', /file\.ts/);
  input().value = 'keep\n';
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'insert', text: 'next' } }));
  assert.equal(input().value, 'keep\nnext');
  assert.equal(document.querySelectorAll('.chip').length, 1);
  click(document.querySelector('.chip button')!);
  assert.equal(input().value.includes('body'), false);
  assert.equal(persisted().draft, input().value);
  input().value = '   ';
  click(visible(document, '.send'));
  assert.equal(posted(sent, 'send'), undefined);
  input().value = '';
  key(input(), 'ArrowUp');
  assert.equal(input().value, '');
  input().value = 'hello';
  input().selectionStart = 1;
  input().selectionEnd = 1;
  key(input(), 'ArrowUp');
  assert.equal(input().value, 'hello');
  click(visible(document, '.send'));
  const sentMessage = posted(sent, 'send');
  assert.equal(sentMessage?.prompt, 'hello');
  assert.equal('conversationId' in (sentMessage ?? {}), false);

  input().value = '@readme extra';
  input().selectionStart = 0;
  input().selectionEnd = 0;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = 'plain text';
  input().selectionStart = input().value.length;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = 'hello /run';
  input().selectionStart = input().value.length;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = '@rea';
  input().selectionStart = 4;
  input().selectionEnd = 4;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const request = posted(sent, 'suggest');
  assert.equal(request?.kind, 'file');
  assert.equal(request?.query, 'rea');
  input().value = '@readme';
  input().selectionStart = 7;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: request?.requestId, items: [{ label: 'stale', token: 'stale.ts' }] },
  }));
  assert.equal(document.querySelector('.suggest')?.hidden, true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const latest = posted(sent, 'suggest');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: latest?.requestId, items: [{ label: 'My File', token: 'my file.ts', description: 'src' }] },
  }));
  const up = key(input(), 'ArrowUp');
  assert.equal(up.defaultPrevented, true);
  assert.equal(input().getAttribute('aria-activedescendant'), 'suggest-0');
  document.querySelector('.suggest-item')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input().value, '@"my file.ts" ');
  input().value = '\n/te';
  input().selectionStart = 4;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const slash = posted(sent, 'suggest');
  assert.equal(slash?.kind, 'slash');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: slash?.requestId, items: [] },
  }));
  assert.equal(input().hasAttribute('aria-activedescendant'), false);
  input().value = '/test';
  input().selectionStart = 5;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const slashChoice = posted(sent, 'suggest');
  assert.equal(slashChoice?.kind, 'slash');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: slashChoice?.requestId, items: [{ label: 'Test', token: 'test' }] },
  }));
  document.querySelector('.suggest-item')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input().value, '/test ');
  globalThis.FileReader = previousReader;
});
