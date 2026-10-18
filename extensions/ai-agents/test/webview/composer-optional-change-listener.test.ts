import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask', description: 'Questions' }],
    mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write', description: 'Default' }, { id: 'read-only', label: 'Read only' }],
    sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }],
    approval: 'never', showApproval: false, webSearchChoices: [{ id: '', label: 'Off' }, { id: 'live', label: 'Live' }],
    webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backendChoices: [{ id: 'sdk', label: 'SDK' }, { id: 'app-server', label: 'App Server' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('a standalone composer can send before an optional change listener is attached', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), new Menu(dom, host), () => {});
  composer.render(shell(), strings('en'));
  composer.draft = 'send without listener';
  click(host.querySelector('.send')!);
  assert.equal(posted(sent, 'send')?.prompt, 'send without listener');

  let changed = 0;
  composer.onInput(() => { changed += 1; });
  composer.draft = 'send with listener';
  click(host.querySelector('.send')!);
  assert.equal(changed, 1);
  assert.equal(posted(sent, 'send')?.prompt, 'send with listener');
});
