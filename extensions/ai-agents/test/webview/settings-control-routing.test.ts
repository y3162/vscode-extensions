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

test('settings changes approval, search, network, directories, and auto-approve', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({
    showApproval: true, showWebSearch: true, showNetwork: true, network: false, autoApprove: true,
    additionalDirectories: ['/extra', '/other'],
  }));
  click(visible(document, '.new-chat'));
  click(visible(document, '.open-settings'));
  const approval = document.querySelector('select[data-key="approval"]') as HTMLSelectElement;
  assert.equal(approval.value, 'never');
  assert.equal(approval.querySelector('option')?.title, '');
  approval.value = 'on-request';
  approval.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.approval, 'on-request');
  assert.equal(posted(sent, 'removeDirectory'), undefined);
  const search = document.querySelector('select[data-key="webSearch"]') as HTMLSelectElement;
  search.value = 'live';
  search.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.webSearch, 'live');
  const sandbox = document.querySelector('select[data-key="sandbox"]') as HTMLSelectElement;
  assert.equal(sandbox.querySelector('option')?.title, 'Default');
  sandbox.value = 'read-only';
  sandbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.sandbox, 'read-only');
  const network = document.querySelector('.check input') as HTMLInputElement;
  assert.equal(network.checked, false);
  network.checked = true;
  network.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.network, true);
  assert.equal(posted(sent, 'configure')?.approval, 'never');
  click([...document.querySelectorAll('.dir-row button')].find((button) => button.closest('.dir-row')?.textContent?.includes('/extra'))!);
  assert.equal(posted(sent, 'removeDirectory')?.path, '/extra');
  assert.equal(countType(sent, 'toggleAutoApprove'), 0);
  const auto = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Auto-approve'))!;
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
  click(auto);
  assert.equal(countType(sent, 'toggleAutoApprove'), 1);
  for (const [label, type] of [['Sign in', 'login'], ['API key', 'apiKey'], ['Diagnose', 'diagnose'], ['Usage', 'usage'], ['Rules / Skills / MCP', 'instructions'], ['Logs', 'logs'], ['VS Code settings', 'settings']] as const) {
    click([...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!);
    assert.equal(posted(sent, type)?.type, type);
  }
  emit(shell({ showApproval: true, showWebSearch: true, showNetwork: true, busy: true, additionalDirectories: ['/extra'] }));
  assert.equal((document.querySelector('select[data-key="approval"]') as HTMLSelectElement).disabled, true);
  assert.equal((document.querySelector('.check input') as HTMLInputElement).disabled, true);
  assert.equal((document.querySelector('.provider') as HTMLButtonElement).disabled, true);
});
