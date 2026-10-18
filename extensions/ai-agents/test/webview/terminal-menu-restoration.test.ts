import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ModelCatalogMessage, ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'front',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function bootApp(saved?: unknown) {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  let persisted = saved ?? null;
  const sent: unknown[] = [];
  const vscode: VsCodeApi = {
    postMessage(message) { sent.push(message); },
    getState: () => persisted,
    setState(state) { persisted = state; },
  };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, diff: { removed?: string[]; upserts?: ViewMessage[]; order?: string[]; full?: boolean } = {}) => {
    const upserts = diff.upserts ?? [];
    window.dispatchEvent(new window.MessageEvent('message', { data: {
      type: 'state', revision: 1, full: diff.full ?? true, shell: next,
      messages: { removed: diff.removed ?? [], upserts, order: diff.order ?? upserts.map((message) => message.id) },
    } }));
    app.flush();
  };
  return { window, sent, app, document: window.document, emit };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

test('app terminal menu labels a restored process with its id when its command is absent', () => {
  const { window, sent, document, emit, app } = bootApp();
  emit(shell({ terminals: [{ processId: 'pid-7' }] }));
  click(document.querySelector('.new-chat') as HTMLElement);
  click(document.querySelector('.open-terminals') as HTMLElement);
  const item = document.querySelector<HTMLButtonElement>('.menu-item[data-id="pid-7"]');
  assert.equal(item?.querySelector('.menu-label')?.textContent, 'pid-7');
  click(item!);
  assert.equal(posted(sent, 'openTerminal')?.processId, 'pid-7');
  app.destroy();
  window.happyDOM.abort();
});
