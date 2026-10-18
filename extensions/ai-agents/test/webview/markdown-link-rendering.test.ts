import assert from 'node:assert/strict';

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

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
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
