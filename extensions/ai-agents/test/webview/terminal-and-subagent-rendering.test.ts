import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

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

test('shell executions use a command card with expandable output', () => {
  const { window, sent, emit } = mount();
  emit(shell(), [
    { id: 'user', role: 'user', text: 'Run sleep', at: 1 },
    { id: 'progress', role: 'assistant', text: 'Executing `sleep 1s`.', at: 2, turnId: 'user' },
    { id: 'command', role: 'tool', text: 'completed: sleep 1s\nslept for one second\n', at: 3, turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'completed', target: 'sleep 1s' } },
    { id: 'answer', role: 'assistant', text: 'Finished.', at: 4, turnId: 'user', final: true },
  ]);

  const log = window.document.querySelector<HTMLElement>('.turn .log')!;
  assert.equal(log.hidden, true);
  click(window.document.querySelector('.log-toggle')!);
  assert.equal(log.hidden, false);
  assert.match(log.querySelector('.progress-note')?.textContent ?? '', /Executing sleep 1s\./);
  let card = log.querySelector<HTMLElement>('.shell-tool')!;
  assert.match(card.querySelector('.shell-tool-heading')?.textContent ?? '', /Run sleep/);
  assert.equal(card.querySelector('.shell-command-line .shell-prompt')?.textContent, '$');
  assert.equal(card.querySelector('.shell-command-line code')?.textContent, 'sleep 1s');
  assert.equal(card.querySelector('.shell-command-output'), null);
  click(card.querySelector('.shell-tool-heading')!);
  card = log.querySelector<HTMLElement>('.shell-tool')!;
  assert.equal(card.querySelector('.shell-tool-heading')?.getAttribute('aria-expanded'), 'true');
  assert.equal(card.querySelector('.shell-command-output')?.textContent, 'slept for one second\n');
  click(card.querySelector('[data-action="copy-source"]')!);
  assert.equal(posted(sent, 'copy')?.text, 'slept for one second\n');
});

test('a background terminal list error remains visible without files or terminals', () => {
  const { window, emit } = mount();
  emit(shell({ terminalError: 'connection lost', changes: [], terminals: [] }));
  const bar = window.document.querySelector('.change-bar');
  assert.equal(bar?.hidden, false);
  assert.match(bar?.textContent ?? '', /connection lost/);
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
  emit(shell({ terminals: [{ ...row, status: 'unknown', output: 'stdout\nstderr\nlatest', error: 'connection lost', outputError: 'Runtime output completeness is unknown: no complete snapshot.' }] }));
  assert.match(window.document.querySelector('.terminal-open')?.textContent ?? '', /unknown/);
  assert.equal(window.document.querySelector('.terminal-output')?.textContent, 'stdout\nstderr\nlatest');
  assert.match(window.document.querySelector('.terminal-row .error-block')?.textContent ?? '', /connection lost/);
  assert.match(window.document.querySelectorAll('.terminal-row .error-block')[1]?.textContent ?? '', /completeness is unknown/);
});

test('finished background terminals remain visible above the composer and in the header', () => {
  const { window, emit } = mount();
  emit(shell({ provider: 'cursor', backend: 'cli', terminals: [{ processId: 'terminal-1', command: 'sleep 120', status: 'cancelled', output: 'READY\nexit_code: unknown' }] }));
  click(visible(window.document, '.new-chat'));
  assert.match(visible(window.document, '.terminal-open').textContent ?? '', /sleep 120.*cancelled/);
  assert.match(window.document.querySelector('.terminal-output')?.textContent ?? '', /READY/);
  assert.equal(window.document.querySelector<HTMLButtonElement>('.terminal-stop')?.disabled, true);
  assert.ok(visible(window.document, '.open-terminals'));
  const list = window.document.querySelector('.terminals')!;
  const form = window.document.querySelector('.composer-card')!;
  assert.ok(list.compareDocumentPosition(form) & window.Node.DOCUMENT_POSITION_FOLLOWING);
});
