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

function countType(sent: unknown[], type: string): number {
  return sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === type).length;
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

test('tool rows, subagents, and edits post the matching command or nothing', () => {
  const { window, sent, emit, document, input } = boot();
  const detail = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
  emit(shell({ locale: 'ja' }), [
    { id: 'user', role: 'user', text: 'go', attachments: ['a.ts'], at: 1, canRewind: true },
    { id: 'user-2', role: 'user', text: 'second', at: 8, canRewind: true },
    { id: 'think', role: 'status', text: 'hmm', at: Date.now() - 5000, turnId: 'user', meta: { type: 'thinking' } },
    { id: 'read', role: 'tool', text: 'read', at: 2, turnId: 'user', tool: { name: 'Read', kind: 'read', status: 'completed', target: 'src/app.ts', line: 2, endLine: 2 } },
    { id: 'range', role: 'tool', text: 'range', at: 3, turnId: 'user', tool: { name: 'Read', kind: 'read', status: 'running', target: 'src/app.ts', line: 2, endLine: 5 } },
    { id: 'edit', role: 'tool', text: 'edit', turnId: 'user', tool: { name: 'Edit', kind: 'edit', status: 'error', target: 'other.ts' } },
    { id: 'search', role: 'tool', text: detail, turnId: 'user', tool: { name: 'Search', kind: 'search', status: 'completed', target: 'query' } },
    { id: 'git', role: 'tool', text: 'git', turnId: 'user', tool: { name: 'Git', kind: 'git', status: 'completed' } },
    { id: 'mcp', role: 'tool', text: 'mcp', turnId: 'user', tool: { name: 'MCP', kind: 'mcp', status: 'completed' } },
    { id: 'task', role: 'tool', text: 'task', turnId: 'user', tool: { name: 'Task', kind: 'subagent', status: 'completed' } },
    { id: 'other', role: 'tool', text: 'other', turnId: 'user', tool: { name: 'Widget', kind: 'other', status: 'completed' } },
    { id: 'shell-run', role: 'tool', text: 'in-progress: npm test\npartial', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'running', target: 'sudo npm test' } },
    { id: 'shell-env', role: 'tool', text: 'hello\nworld', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'completed', target: 'FOO=bar echo hi' } },
    { id: 'shell-bad', role: 'tool', text: 'completed: echo', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'error', target: '|' } },
    { id: 'sub-a', role: 'status', text: 'a', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's1', name: 'one', status: 'unknown', background: 'unknown', model: 'gpt', durationMs: 1500, task: 'look', resultPreview: 'found' } } },
    { id: 'sub-b', role: 'status', text: 'b', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's2', name: 'two', status: 'completed', background: true } } },
    { id: 'sub-c', role: 'status', text: 'c', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's3', name: 'three', status: 'error', background: 'unknown' } } },
    { id: 'sub-d', role: 'status', text: 'd', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's4', name: 'four', status: 'cancelled', background: 'unknown' } } },
    { id: 'sub-e', role: 'status', text: 'e', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's5', name: 'five', status: 'running', background: 'unknown' } } },
    { id: 'todos', role: 'status', text: 'todos', turnId: 'user', meta: { type: 'todo', todos: [{ content: 'ship', status: 'done' }, { content: 'wait', status: 'pending' }] } },
    { id: 'answer', role: 'assistant', text: 'ok', at: 9, turnId: 'user', final: true },
  ]);
  click(visible(document, '.new-chat'));
  const read = document.querySelector('[data-action="open-file"][data-path="src/app.ts"]') as HTMLButtonElement;
  assert.equal(read.title, 'Open src/app.ts:2');
  click(read);
  assert.equal(posted(sent, 'openFile')?.line, 2);
  assert.equal(posted(sent, 'openFile')?.endLine, 2);
  const ranged = [...document.querySelectorAll('[data-action="open-file"]')].find((node) => node.getAttribute('data-end-line') === '5');
  assert.match(ranged?.textContent ?? '', /L2-5/);
  click([...document.querySelectorAll('[data-action="toggle-tool"]')].find((node) => node.textContent?.includes('Search'))!);
  click(document.querySelector('[data-action="more"]')!);
  assert.match(document.querySelector('.tool-row-item pre')?.textContent ?? '', /line 40/);
  assert.match(document.body.textContent ?? '', /実行 npm/);
  assert.match(document.body.textContent ?? '', /実行 echo/);
  assert.match(document.body.textContent ?? '', /コマンドを実行/);
  assert.match(document.querySelector('.subagents')?.textContent ?? '', /バックグラウンド/);
  assert.match(document.querySelector('.subagents')?.textContent ?? '', /gpt/);
  assert.match(document.querySelector('.thinking summary')?.textContent ?? '', /思考/);
  click(document.querySelector('.copy-answer')!);
  const copied = posted(sent, 'copy');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: copied?.requestId, ok: false } }));
  assert.match(document.querySelector('.copy-answer')?.getAttribute('title') ?? '', /失敗/);
  click([...document.querySelectorAll('.bubble')].at(-1)!);
  const editor = document.querySelector('.edit-prompt') as HTMLTextAreaElement;
  editor.value = 'rewritten';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(document.querySelector('[data-action="rewind"]')!);
  assert.equal(posted(sent, 'rewind')?.turnId, 'user-2');
  assert.equal(posted(sent, 'rewind')?.editedText, 'rewritten');
  assert.equal(posted(sent, 'send'), undefined);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'go', at: 1, canRewind: true },
    { id: 'failed', role: 'error', text: 'nope', at: 2 },
  ]);
  click(document.querySelector('[data-action="retry"]')!);
  assert.equal(posted(sent, 'prepareRetry'), undefined);
  assert.equal(posted(sent, 'send'), undefined);
  const root = document.querySelector('.thread')!;
  const stray = document.createElement('button');
  stray.dataset.action = 'copy-answer';
  root.append(stray);
  const copies = countType(sent, 'copy');
  click(stray);
  assert.equal(countType(sent, 'copy'), copies);
  const diff = document.createElement('button');
  diff.dataset.action = 'open-diff';
  diff.dataset.path = 'src/app.ts';
  diff.dataset.line = '3';
  diff.dataset.endLine = '8';
  diff.dataset.column = '2';
  root.append(diff);
  click(diff);
  assert.deepEqual(posted(sent, 'openDiff'), {
    provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'openDiff', path: 'src/app.ts', line: 3, endLine: 8, column: 2,
  });
  const zero = document.createElement('button');
  zero.dataset.action = 'open-file';
  zero.dataset.path = 'zero.ts';
  zero.dataset.line = '0';
  root.append(zero);
  click(zero);
  assert.equal(posted(sent, 'openFile')?.path, 'zero.ts');
  assert.equal('line' in (posted(sent, 'openFile') ?? {}), false);
  emit(shell(), []);
  assert.match(document.querySelector('.empty')?.textContent ?? '', /AI Agents/);
  assert.equal(input().value, '');
  void window;
});
