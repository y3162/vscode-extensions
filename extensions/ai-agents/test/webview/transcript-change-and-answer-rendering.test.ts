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

test('diffs, icons, and streaming answers keep fold state across renders', () => {
  const { window, sent, emit, document } = boot();
  const preview = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'context' as const, line: index + 1, text: `line ${index}` }));
  const files = (count: number, additions = 1) => [{
    id: 'user', role: 'user' as const, text: 'edit', at: 1,
  }, {
    id: 'files', role: 'tool' as const, text: 'changed', at: 2, turnId: 'user',
    meta: { type: 'files' as const, files: [{ path: 'src/app.ts', kind: 'update', additions, deletions: 0, preview: preview(count) }] },
  }];
  emit(shell(), files(6));
  click(visible(document, '.new-chat'));
  assert.equal(document.querySelector('.diff-preview-toggle'), null);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 6);
  emit(shell(), files(7));
  assert.equal(document.querySelector('.diff-preview-toggle'), null);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 7);
  emit(shell(), files(8));
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 6);
  click(document.querySelector('.diff-preview-toggle')!);
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), true);
  emit(shell(), files(8, 2));
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), true);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 8);
  click(document.querySelector('.diff-preview-toggle')!);
  emit(shell(), files(8, 3));
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), false);
  const mixed = [
    { kind: 'context' as const, line: 1, text: 'a' },
    { kind: 'remove' as const, line: 2, text: 'b' },
    { kind: 'add' as const, line: 2, text: 'c' },
    { kind: 'context' as const, line: 3, text: 'd' },
    { kind: 'context' as const, line: 4, text: 'e' },
    { kind: 'context' as const, line: 5, text: 'f' },
    { kind: 'more' as const, text: 'omitted' },
    { kind: 'eof' as const, text: 'end' },
  ];
  emit(shell(), [{ id: 'user', role: 'user', text: 'edit', at: 1 }, { id: 'files', role: 'tool', text: 'changed', at: 2, turnId: 'user', meta: { type: 'files', files: [
    { path: 'Makefile', kind: 'update', preview: mixed, icon: { type: 'badge', badge: 'MK' } },
    { path: 'shot.png', kind: 'update', additions: 1, preview: [{ kind: 'add', line: 1, text: 'x' }], icon: { type: 'image', src: 'https://example.test/png.svg' } },
    { path: 'app.ts', kind: 'update', deletions: 2, preview: [{ kind: 'remove', text: 'old' }], icon: { type: 'font', fontCharacter: '\\E111', fontFamily: 'seti', fontColor: '#abc' } },
    { path: 'dir/', kind: 'update', preview: [{ kind: 'context', text: 'name' }] },
  ] } }]);
  assert.equal(document.querySelector('.file-badge')?.textContent, 'MK');
  assert.equal(document.querySelector('.file-badge')?.dataset.lang, 'file');
  assert.equal(document.querySelector('.diff-preview-line.more')?.textContent, 'omitted');
  assert.equal(document.querySelector('img.file-icon')?.getAttribute('src'), 'https://example.test/png.svg');
  assert.equal(document.querySelector('.font-icon')?.textContent, '\uE111');
  assert.equal(document.querySelectorAll('.file-link')[3]?.textContent, 'dir/');
  click(document.querySelector('.diff-preview-toggle')!);
  assert.equal(document.querySelector('.diff-preview-line.eof')?.textContent, 'end');
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'x'.repeat(20)} **z**`, at: 2, turnId: 'user' },
  ]);
  assert.equal(document.querySelector('.answer .md strong')?.textContent, 'z');
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: 'y'.repeat(4000), at: 2, turnId: 'user' },
  ]);
  const streaming = document.querySelector('.answer .md') as HTMLElement;
  assert.equal(streaming.classList.contains('is-streaming'), false);
  assert.equal(streaming.querySelector('p')?.textContent?.length, 4000);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'y'.repeat(4000)}Z`, at: 2, turnId: 'user' },
  ]);
  assert.equal(streaming.textContent?.endsWith('Z'), true);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: 'n'.repeat(4000), at: 2, turnId: 'user' },
  ]);
  assert.equal(streaming.textContent, 'n'.repeat(4000));
  emit(shell(), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'n'.repeat(4000)}\n\n**done**`, at: 2, turnId: 'user', final: true },
  ]);
  assert.equal(document.querySelector('.answer .md strong')?.textContent, 'done');
  void window;
  void sent;
});
