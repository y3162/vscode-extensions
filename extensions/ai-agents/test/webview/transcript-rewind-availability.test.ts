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

test('transcript safely refuses unavailable rewind and refreshes a changed tool segment', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  const base = (canRewind: boolean, kind: 'read' | 'edit'): ViewMessage[] => [
    { id: 'user', role: 'user', text: 'prompt', canRewind },
    { id: 'tool', role: 'tool', text: 'details', turnId: 'user', tool: { name: 'Inspect', kind, status: 'completed', target: 'src/a.ts' } },
  ];
  transcript.render(base(false, 'read'), shell(), strings('en'));
  const edit = root.querySelector<HTMLButtonElement>('.edit-user')!;
  assert.match(edit.title, /cannot be safely rewound/);
  click(edit);
  assert.equal(root.querySelector('.edit-prompt'), null);

  click(root.querySelector('.log-toggle') as HTMLElement);
  assert.ok(root.querySelector('.tool-row-item .codicon-file'));
  transcript.render(base(false, 'edit'), shell(), strings('en'));
  assert.ok(root.querySelector('.tool-row-item .codicon-edit'));
  window.happyDOM.abort();
});
