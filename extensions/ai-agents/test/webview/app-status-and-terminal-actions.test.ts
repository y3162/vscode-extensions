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

test('usage, banners, changes, terminals, and the queue post their own commands', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, inputIncludesCache: false },
    banner: { id: 'warn', title: 'Careful', body: 'Details' },
    additions: 3, deletions: 1,
    changes: [
      { path: 'src/app.ts', name: 'app.ts', kind: 'update', additions: 3, deletions: 1, canRevert: true, canDiff: true, synthetic: false },
      { path: 'README', name: 'README', kind: 'add', canRevert: false, canDiff: false, synthetic: false },
    ],
    terminals: [{ processId: 'p1', command: 'npm test', status: 'running', output: 'log', error: 'oops' }, { processId: 'p2' }],
  }));
  click(visible(document, '.new-chat'));
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /Input excludes cache/);
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /—/);
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /Not reported/);
  click([...document.querySelectorAll('.banner button')].find((button) => button.textContent?.includes("Don't show"))!);
  assert.equal(posted(sent, 'dismissWarning')?.id, 'warn');
  click(document.querySelector('.banner .icon-btn')!);
  assert.equal(countType(sent, 'dismissWarning'), 2);
  assert.equal(posted(sent, 'send'), undefined);
  assert.match(document.querySelector('.change-head')?.textContent ?? '', /2 Files/);
  assert.match(document.querySelector('.change-head')?.textContent ?? '', /Undo All/);
  assert.match(document.querySelector('.change-head')?.textContent ?? '', /Keep All/);
  assert.doesNotMatch(document.querySelector('.change-head')?.textContent ?? '', /\+3 −1/);
  assert.match(document.querySelector('.change-file .add')?.textContent ?? '', /\+3/);
  click([...document.querySelectorAll('.change-head button')].find((button) => button.textContent?.includes('Review'))!);
  assert.equal(posted(sent, 'reviewChanges')?.type, 'reviewChanges');
  const files = [...document.querySelectorAll('.change-file')];
  click(files[0]?.querySelector('.file-link')!);
  assert.equal(posted(sent, 'openDiff')?.path, 'src/app.ts');
  click(files[0]?.querySelector('button.tiny')!);
  assert.equal(posted(sent, 'revertFile')?.path, 'src/app.ts');
  click(files[1]?.querySelector('.file-link')!);
  assert.equal(posted(sent, 'openFile')?.path, 'README');
  assert.equal(posted(sent, 'openDiff')?.path, 'src/app.ts');
  click(visible(document, '.terminal-heading'));
  assert.equal(document.querySelector('.terminal-items')?.hidden, true);
  assert.match(document.querySelector('.terminal-heading .codicon')?.className ?? '', /chevron-right/);
  click(visible(document, '.terminal-heading'));
  assert.match(document.querySelector('.terminal-heading .codicon')?.className ?? '', /chevron-down/);
  assert.match(document.querySelectorAll('.terminal-open')[1]?.textContent ?? '', /p2/);
  assert.equal(document.querySelectorAll('.terminal-state').length, 1);
  emit(shell({ terminals: [{ processId: 'done', command: 'echo', status: 'completed' }], changes: [], additions: 0, deletions: 0 }));
  assert.doesNotMatch(document.querySelector('.change-head')?.textContent ?? '', /\+/);
  const stop = document.querySelector('.terminal-stop') as HTMLButtonElement;
  assert.equal(stop.disabled, true);
  click(stop);
  assert.equal(posted(sent, 'terminateTerminal'), undefined);
  emit(shell({
    busy: true, steer: true, presence: 'running', statusText: 'Running',
    queue: [{ id: 'q1', text: 'later', images: 0 }],
    usage: null,
  }));
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /No token estimate/);
  click([...document.querySelectorAll('.queue-item button')].find((button) => button.textContent?.includes('Send now'))!);
  assert.equal(posted(sent, 'sendNow')?.id, 'q1');
  click([...document.querySelectorAll('.queue-item button')].find((button) => button.textContent?.includes('Steer'))!);
  assert.equal(posted(sent, 'steer')?.id, 'q1');
  click(document.querySelector('.queue-item .icon-btn')!);
  assert.equal(posted(sent, 'removeQueued')?.id, 'q1');
  emit(shell({ busy: true, steer: false, queue: [{ id: 'q2', text: 'quiet', images: 0 }] }));
  assert.equal([...document.querySelectorAll('.queue-item button')].some((button) => button.textContent?.includes('Steer')), false);
});
