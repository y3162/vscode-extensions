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
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
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

test('file links preserve absolute paths and send Markdown destinations and locations', () => {
  const absolute = '/Users/sekiyuuta/Developer/y3162/vscode-extensions/README.md';
  const cases = [
    { text: absolute, label: absolute, path: absolute },
    { text: `[README.md](${absolute})`, label: 'README.md', path: absolute },
    { text: `[README.md](${absolute}:12)`, label: 'README.md', path: absolute, line: 12 },
    { text: '[app.ts](src/app.ts:2:3)', label: 'app.ts', path: 'src/app.ts', line: 2, column: 3 },
    { text: `[README](file://${absolute}#L12)`, label: 'README', path: `file://${absolute}`, line: 12 },
    { text: '[Report](</workspace/My Project/README.md:4>)', label: 'Report', path: '/workspace/My Project/README.md', line: 4 },
    { text: '[Report](docs/My%20Report.md)', label: 'Report', path: 'docs/My Report.md' },
    { text: 'src/app.ts:2', label: 'src/app.ts:2', path: 'src/app.ts', line: 2 },
    { text: 'C:\\workspace\\src\\app.ts:2:3', label: 'C:\\workspace\\src\\app.ts:2:3', path: 'C:\\workspace\\src\\app.ts', line: 2, column: 3 },
  ];
  for (const item of cases) {
    const { window, sent, emit } = mount();
    emit(shell(), [{ id: 'answer', role: 'assistant', text: item.text, at: 1 }]);
    const links = window.document.querySelectorAll<HTMLButtonElement>('.answer .file-link');
    assert.equal(links.length, 1, item.text);
    assert.equal(links[0]?.textContent, item.label, item.text);
    click(links[0]!);
    assert.deepEqual(posted(sent, 'openFile'), {
      provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'openFile', path: item.path,
      ...('line' in item ? { line: item.line } : {}),
      ...('column' in item ? { column: item.column } : {}),
    }, item.text);
  }
});

test('web URLs stay external and unsupported link schemes never become file actions', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  renderMarkdown(host, '[Docs](https://example.com/src/app.ts) https://example.com/src/app.ts', dom);
  assert.equal(host.querySelectorAll('a').length, 2);
  assert.equal(host.querySelector('.file-link'), null);
  renderMarkdown(host, '[Run](command:workbench.action.openSettings) [Bad](javascript:alert) [Remote](vscode://file/workspace/src/app.ts)', dom);
  assert.equal(host.querySelector('a'), null);
  assert.equal(host.querySelector('.file-link'), null);
});

test('Enter allows newlines and IME confirmation, and only the send button sends', () => {
  const { window, sent, input, emit } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  const prompt = input();
  prompt.value = 'hello';
  for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', ...modifiers, bubbles: true, cancelable: true });
    prompt.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
    assert.equal(posted(sent, 'send'), undefined);
    assert.equal(posted(sent, 'enqueue'), undefined);
    assert.equal(prompt.value, 'hello');
  }
  prompt.dispatchEvent(new window.Event('compositionstart'));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  prompt.dispatchEvent(new window.Event('compositionend'));
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(posted(sent, 'send'), undefined);
  const submit = new window.Event('submit', { bubbles: true, cancelable: true });
  window.document.querySelector('form')!.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(posted(sent, 'send'), undefined);
  prompt.value = 'こんにちは\n続きのメッセージ';
  click(visible(window.document, '.send'));
  assert.deepEqual(posted(sent, 'send'), {
    provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'send', prompt: 'こんにちは\n続きのメッセージ', images: [],
  });
  assert.equal(sent.filter((message) => (message as { type: string }).type === 'send').length, 1);
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
  prompt.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(posted(sent, 'enqueue'), undefined);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'chat' } }));
  click(visible(window.document, '.send'));
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

test('suggestion arrows and Tab insert the highlighted file while Enter allows a newline', async () => {
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
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  prompt.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.equal(prompt.value, '@re');
  assert.equal(posted(sent, 'send'), undefined);
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

test('the model menu searches, checks the selection, and keeps the draft', () => {
  const { window, sent, input, emit } = mount();
  emit(shell({ modelLabel: 'A very long model name that must stay on one line' }));
  input().value = 'keep this sentence';
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  assert.equal(typeof request?.requestId, 'number');
  const deliver = (requestId: number) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: {
        type: 'modelCatalog', requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
        selectedModelId: 'gpt-6', selectedParams: [{ id: 'modelReasoningEffort', value: 'xhigh' }],
        models: [
          {
            id: 'gpt-6', label: 'GPT-6.1 Sol', aliases: ['sol'], description: 'Balanced',
            parameters: [{
              id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu',
              values: [
                { value: 'low', label: 'Low' },
                { value: 'xhigh', label: 'Extra High' },
              ],
            }],
          },
          { id: 'other', label: 'Other Model', parameters: [] },
        ],
      },
    }));
  };
  deliver(99);
  assert.match(window.document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);
  deliver(Number(request?.requestId));
  const effort = visible(window.document, '.menu-item[data-id="modelReasoningEffort"]');
  assert.match(effort.textContent ?? '', /Extra High/);
  click(effort);
  const extra = visible(window.document, '.menu-item[data-id="modelReasoningEffort:xhigh"]');
  assert.equal(extra.getAttribute('aria-checked'), 'true');
  extra.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(window.document.querySelector('.menu-item[data-id="modelReasoningEffort:xhigh"]'), null);
  assert.equal(window.document.querySelector('.model-menu')?.hidden, false);
  window.document.querySelector('.model-menu')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(window.document.querySelector('.model-menu')?.hidden, true);
  assert.equal(input().value, 'keep this sentence');

  click(visible(window.document, '.model-name'));
  const again = posted(sent, 'loadModelCatalog');
  deliver(Number(again?.requestId));
  click(visible(window.document, '.menu-item[data-id="model"]'));
  const search = window.document.querySelector('.menu-search') as HTMLInputElement;
  assert.equal(search.placeholder, 'Search models');
  assert.equal(window.document.querySelector('[data-id="model:default"]'), null);
  assert.doesNotMatch(search.closest('.model-menu')?.textContent ?? '', /Default model/);
  assert.equal(visible(window.document, '.menu-item[data-id="model:gpt-6"]').getAttribute('aria-checked'), 'true');
  assert.match(visible(window.document, '.menu-item[data-id="model:gpt-6"]').title, /A very long model name|GPT-6.1 Sol/);
  search.value = 'missing-model';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(search.closest('.model-menu')?.textContent ?? '', /No matching models/);
  search.value = 'SOL';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(window.document.querySelector('.menu-item[data-id="model:gpt-6"]'));
  window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(window.document.querySelector('.model-menu')?.hidden, true);
  assert.equal(input().value, 'keep this sentence');

  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /\.vscode-high-contrast \.menu/);
  assert.match(css, /--vscode-editorWidget-background/);
  assert.match(window.document.querySelector('.model-name')?.textContent ?? '', /A very long model name/);
  assert.match(window.document.querySelector('.model-name')?.getAttribute('title') ?? '', /A very long model name that must stay on one line/);
});

test('a narrow model menu drills in instead of opening beside the root', () => {
  const { window, sent, emit } = mount();
  window.innerWidth = 300;
  window.innerHeight = 640;
  emit(shell());
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'modelCatalog', requestId: request?.requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
      selectedModelId: 'gpt', selectedParams: [{ id: 'fast', value: 'false' }],
      models: [{ id: 'gpt', label: 'GPT', parameters: [{ id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] }] }],
    },
  }));
  assert.equal(window.document.querySelector('.menu-item[data-id="fast"]')?.getAttribute('aria-checked'), 'false');
  click(visible(window.document, '.menu-item[data-id="model"]'));
  assert.ok(window.document.querySelector('.menu-item[data-id="back"]'));
  assert.equal(window.document.querySelector('.model-menu.submenu')?.hidden, true);
  window.document.querySelector('.model-menu')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  click(visible(window.document, '.menu-item[data-id="model:gpt"]'));
  assert.equal(posted(sent, 'setModel')?.modelId, 'gpt');
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

test('terminals render without file changes and unknown subagents are not labeled background', () => {
  const { window, sent, emit } = mount();
  emit(shell({
    busy: true,
    presence: 'running',
    changes: [],
    terminals: [{ processId: 'p1', command: 'sleep 30', status: 'running' }],
    planView: {
      id: 'plan-1', revision: 1, phase: 'ready', markdown: 'Do the thing', todos: [], source: 'assistant-text',
      buildModelId: 'composer-2.5', buildModelLabel: 'Composer 2.5', buildParams: [], showBuildModel: true, canBuild: true, history: [],
    },
  }), [
    { id: 'user', role: 'user', text: 'look', at: 1 },
    { id: 'sub', role: 'status', text: 'Explore', meta: { type: 'subagent', subagent: { id: 's1', name: 'explore', status: 'running', background: 'unknown', task: 'read files', resultPreview: 'found' } } },
  ]);
  const app = window.document.getElementById('app') as HTMLElement;
  app.style.width = '300px';
  assert.match(window.document.querySelector('.terminal-row')?.textContent ?? '', /sleep 30/);
  assert.equal(window.document.querySelector('.change-file'), null);
  (window.document.querySelector('.terminal-row .terminal-open') as HTMLButtonElement).click();
  assert.equal(posted(sent, 'openTerminal')?.processId, 'p1');
  (window.document.querySelector('.terminal-row .terminal-stop') as HTMLButtonElement).click();
  assert.equal(posted(sent, 'terminateTerminal')?.processId, 'p1');
  const subagent = window.document.querySelector('.subagent');
  assert.match(subagent?.textContent ?? '', /explore/);
  assert.match(subagent?.textContent ?? '', /found/);
  assert.doesNotMatch(subagent?.textContent ?? '', /Background/);
  const build = window.document.querySelector('.build') as HTMLButtonElement;
  assert.equal(build.disabled, false);
  app.style.width = '390px';
  assert.ok(window.document.querySelector('.composer-row'));
  assert.ok(window.document.querySelector('.plan-actions'));
  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /\.plan-actions, \.terminal-row, \.change-head \{ flex-wrap: wrap; \}/);
});

test('file theme CSS escapes render as glyphs and invalid code points fall back safely', () => {
  const { window, emit } = mount();
  for (const [fontCharacter, expected] of [['\\E023', '\uE023'], ['\uE023', '\uE023'], ['\\110000', 'NO'], ['\\D800', 'NO']]) {
    emit(shell({ changes: [{ path: 'note.txt', name: 'note.txt', kind: 'update', canRevert: false, canDiff: false, synthetic: false,
      icon: { type: 'font', fontCharacter, fontFamily: 'seti' } }] }));
    assert.equal(window.document.querySelector('.change-file .file-icon, .change-file .file-badge')?.textContent, expected);
  }
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

test('copy uses original Markdown/code/user/tool text and reports host success or failure', () => {
  const { window, sent, emit } = mount();
  const answer = '**日本語 😀**\n\n```ts\nconst x = "λ";\nconsole.log(x);\n```';
  emit(shell(), [
    { id: 'u', role: 'user', text: '質問\n二行', at: 1 },
    { id: 't', role: 'tool', text: 'stdout\nstderr 😀', at: 2, tool: { name: 'shell', kind: 'shell', status: 'completed' } },
    { id: 'a', role: 'assistant', text: answer, final: true, at: 3 },
  ]);
  assert.ok(window.document.querySelector('.answer > .message-actions > .copy-answer'));
  assert.ok(window.document.querySelector('.user-row > .message-actions > .copy-user'));
  click(window.document.querySelector('.copy-answer')!);
  let request = posted(sent, 'copy')!; assert.equal(request.text, answer);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: request.requestId, ok: true } }));
  assert.match(window.document.querySelector('.copy-answer')!.getAttribute('title')!, /Copied/);
  click(window.document.querySelector('[data-action="copy-code"]')!);
  request = posted(sent, 'copy')!; assert.equal(request.text, 'const x = "λ";\nconsole.log(x);');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: request.requestId, ok: false } }));
  assert.match(window.document.querySelector('[data-action="copy-code"]')!.getAttribute('title')!, /failed/);
  click(window.document.querySelector('.user-row [data-action="copy-source"]')!);
  assert.equal(posted(sent, 'copy')!.text, '質問\n二行');
  click(window.document.querySelector('.log-toggle')!);
  click(window.document.querySelector('[data-action="toggle-tool"]')!);
  click(window.document.querySelector('.tool-row-item [data-action="copy-source"]')!);
  assert.equal(posted(sent, 'copy')!.text, 'stdout\nstderr 😀');
});

test('token usage is visibly rendered with cache semantics, context and unsupported state', () => {
  const { window, emit } = mount();
  emit(shell({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, totalTokens: 120, inputIncludesCache: true, contextWindow: 1000, contextTokens: 100 } }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Input 100.*Output 20.*Total 120/);
  assert.match(window.document.querySelector('.usage-panel pre')!.textContent!, /10.0%/);
  emit(shell({ backend: 'acp', usage: null }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Unsupported/);
});


test('a background terminal list error remains visible without files or terminals', () => {
  const { window, emit } = mount();
  emit(shell({ terminalError: 'connection lost', changes: [], terminals: [] }));
  const bar = window.document.querySelector('.change-bar');
  assert.equal(bar?.hidden, false);
  assert.match(bar?.textContent ?? '', /connection lost/);
});


test('message editing restores the original prompt as a focused draft without sending', () => {
  const { window, sent, emit, input } = mount();
  const original = '日本語の質問\n二行目';
  emit(shell(), [
    { id: 'u', role: 'user', text: original, at: 1 },
    { id: 'a', role: 'assistant', text: 'Answer', final: true, at: 2 },
  ]);
  click(visible(window.document, '.new-chat'));
  input().value = 'draft';
  click(window.document.querySelector('.user-row > .message-actions > .edit-user')!);
  assert.equal(input().value, original);
  assert.equal(window.document.activeElement, input());
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(posted(sent, 'prepareRetry'), undefined);
  assert.equal(window.document.querySelector('.bubble')?.textContent, original);
});


test('background terminals open from the chat header and preserve their conversation identity', () => {
  const { window, sent, emit } = mount();
  emit(shell({ terminals: [{ processId: 'p1', command: 'sleep 120' }] }));
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.open-terminals'));
  const item = visible(window.document, '.menu-item[data-id="p1"]');
  assert.match(item.textContent ?? '', /sleep 120/);
  click(item);
  assert.deepEqual(posted(sent, 'openTerminal'), {
    provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'openTerminal', processId: 'p1',
  });
  click(visible(window.document, '.terminal-heading'));
  assert.equal(window.document.querySelector('.terminal-items')?.hidden, true);
  emit(shell({ terminals: [{ processId: 'p1', command: 'sleep 120', output: 'new output' }] }));
  assert.equal(window.document.querySelector('.terminal-items')?.hidden, true);
});


test('chat keeps live terminal state and output alongside the panel opener', () => {
  const { window, sent, emit } = mount();
  const row = { processId: 'p1', command: 'build', status: 'running', output: 'stdout\nstderr' };
  emit(shell({ terminals: [row] }));
  click(visible(window.document, '.new-chat'));
  assert.match(window.document.querySelector('.terminal-open')?.textContent ?? '', /running/);
  assert.equal(window.document.querySelector('.terminal-output')?.textContent, row.output);
  click(window.document.querySelector('.terminal-open')!);
  assert.equal(posted(sent, 'openTerminal')?.processId, 'p1');
  assert.equal(window.document.querySelector('.terminal-output')?.textContent, row.output);
  emit(shell({ terminals: [{ ...row, status: 'unknown', output: 'stdout\nstderr\nlatest', error: 'connection lost' }] }));
  assert.match(window.document.querySelector('.terminal-open')?.textContent ?? '', /unknown/);
  assert.equal(window.document.querySelector('.terminal-output')?.textContent, 'stdout\nstderr\nlatest');
  assert.match(window.document.querySelector('.terminal-row .error-block')?.textContent ?? '', /connection lost/);
});


test('finished SDK background terminals remain visible above the composer and in the header', () => {
  const { window, emit } = mount();
  emit(shell({ provider: 'cursor', backend: 'sdk', terminals: [{ processId: 'sdk-1', command: 'sleep 120', status: 'cancelled', output: 'READY\nexit_code: unknown' }] }));
  click(visible(window.document, '.new-chat'));
  assert.match(visible(window.document, '.terminal-open').textContent ?? '', /sleep 120.*cancelled/);
  assert.match(window.document.querySelector('.terminal-output')?.textContent ?? '', /READY/);
  assert.equal(window.document.querySelector<HTMLButtonElement>('.terminal-stop')?.disabled, true);
  assert.ok(visible(window.document, '.open-terminals'));
  const list = window.document.querySelector('.terminals')!;
  const form = window.document.querySelector('.composer-card')!;
  assert.ok(list.compareDocumentPosition(form) & window.Node.DOCUMENT_POSITION_FOLLOWING);
});
