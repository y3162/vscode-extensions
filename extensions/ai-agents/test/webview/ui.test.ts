import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createApp } from '../../src/webview/app.js';
import { createDom } from '../../src/webview/dom.js';
import { renderMarkdown } from '../../src/webview/markdown.js';
import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'high',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
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
  const vscode: VsCodeApi = { postMessage(message) { sent.push(message); }, getState: () => null, setState: () => {} };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  return { window, sent, app, emit, input: () => window.document.querySelector('textarea') as HTMLTextAreaElement };
}

test('markdown stays text and reuses completed blocks', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  renderMarkdown(host, 'Hello\n\n<script>alert(1)</script>', dom);
  assert.equal(host.querySelector('script'), null);
  assert.match(host.textContent ?? '', /<script>alert\(1\)<\/script>/);
  const first = host.firstElementChild;
  renderMarkdown(host, 'Hello\n\n<script>alert(1)</script>\n\nLater', dom);
  assert.equal(host.firstElementChild, first);
  assert.match(host.textContent ?? '', /Later/);
});

test('Enter sends, Shift+Enter does not, and IME confirmation does not send', async () => {
  const { window, sent, input, emit } = mount();
  emit(shell());
  const prompt = input();
  prompt.value = 'hello';
  const shift = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
  prompt.dispatchEvent(shift);
  assert.equal(shift.defaultPrevented, false);
  assert.equal(posted(sent, 'send'), undefined);
  prompt.dispatchEvent(new window.Event('compositionend'));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(posted(sent, 'send'), undefined);
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
  assert.equal(posted(sent, 'send'), undefined);
  await new Promise((resolve) => setTimeout(resolve, 120));
  prompt.value = 'hello';
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(posted(sent, 'send')?.prompt, 'hello');
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
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
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
});

test('suggestion arrows insert the highlighted file', async () => {
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
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
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
