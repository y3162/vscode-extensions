import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }, { id: 'cursor', label: 'Cursor', detail: 'ACP' }],
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
  click(visible(window.document, '.menu-item[data-id="plan"]'));
  assert.equal(posted(sent, 'configure')?.mode, 'plan');
  click(visible(window.document, '.model-name'));
  click(visible(window.document, '.menu-item[data-id="model"]'));
  assert.ok(posted(sent, 'chooseModel'));
  click(visible(window.document, '.model-name'));
  click(visible(window.document, '.menu-item[data-id="details"]'));
  assert.ok(posted(sent, 'modelDetails'));
  assert.match(window.document.querySelector('.model-name')?.textContent ?? '', /gpt high/);
  emit(shell({ sessions: [], effortLabel: null }));
  const before = sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === 'chooseModel').length;
  click(visible(window.document, '.model-name'));
  const after = sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === 'chooseModel').length;
  assert.equal(after, before + 1);
  assert.equal(window.document.querySelector('.menu')?.hidden, true);
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
  assert.equal(posted(sent, 'restoreSession'), undefined);
  assert.match(window.document.querySelector('.host-error')?.textContent ?? '', /Wait for the current run/);
  assert.equal(root?.dataset.page, 'home');
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

test('the view title does not duplicate home and chat actions', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[]; menus?: { 'view/title'?: { command: string }[] } };
  };
  const titled = manifest.contributes.menus?.['view/title']?.map((item) => item.command) ?? [];
  for (const command of ['ai-agents.newChat', 'ai-agents.showHistory', 'ai-agents.showSettings', 'ai-agents.stop', 'ai-agents.signIn', 'ai-agents.apiKey', 'ai-agents.diagnose', 'ai-agents.usage', 'ai-agents.instructions', 'ai-agents.showLogs']) {
    assert.equal(titled.includes(command), false, command);
  }
  const commands = manifest.contributes.commands.map((item) => item.command);
  for (const command of ['ai-agents.newChat', 'ai-agents.showHistory', 'ai-agents.showSettings', 'ai-agents.stop', 'ai-agents.signIn', 'ai-agents.diagnose']) {
    assert.equal(commands.includes(command), true, command);
  }
});
