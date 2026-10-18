import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

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

test('transcript cancels stale edits, refreshes a newly selected turn, and ignores text-node clicks', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const postedMessages: unknown[] = [];
  const transcript = new Transcript(dom, root, (message) => postedMessages.push(message), () => {}, () => {}, () => {});
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'first', at: 1, canRewind: true },
    { id: 'answer-1', role: 'assistant', text: 'answer one', at: 2, turnId: 'user-1', final: true },
    { id: 'user-2', role: 'user', text: 'second', at: 3, canRewind: true },
    { id: 'answer-2', role: 'assistant', text: 'answer two', at: 4, turnId: 'user-2', final: true },
  ];
  transcript.render(messages, shell(), strings('en'));
  const firstTurn = root.querySelector<HTMLElement>('[data-id="user-1"]')!;
  const secondTurn = root.querySelector<HTMLElement>('[data-id="user-2"]')!;
  click(firstTurn.querySelector('.edit-user') as HTMLElement);
  click(secondTurn.querySelector('.edit-user') as HTMLElement);
  assert.equal(firstTurn.querySelector('.edit-prompt'), null);
  assert.ok(secondTurn.querySelector('.edit-prompt'));

  const textNode = secondTurn.querySelector('.turn-usage')!.appendChild(window.document.createTextNode('not a button'));
  textNode.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(postedMessages, []);

  transcript.render(messages.slice(0, 2), shell({ timings: [{
    id: 'user-1', startedAt: 1, endedAt: 2, waitMs: 0, status: 'completed', intent: 'chat', usage: { inputTokens: 2, outputTokens: 1 },
  }] }), strings('en'));
  assert.equal(root.querySelector('[data-id="user-2"]'), null);
  assert.equal(root.querySelector('[data-id="user-1"] .edit-prompt'), null);
  assert.match(root.querySelector('[data-id="user-1"] .turn-usage')?.textContent ?? '', /Input 2/);
  window.happyDOM.abort();
});
