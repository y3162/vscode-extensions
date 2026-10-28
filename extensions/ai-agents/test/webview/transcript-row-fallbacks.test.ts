import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ViewShell } from '../../src/protocol.js';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function shell(): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'Chat', modelLabel: 'Model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [], modes: [{ id: 'agent', label: 'Agent' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'conversation',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }],
  };
}

function bootTranscript() {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const sent: unknown[] = [];
  const rewinds: { id: string; text: string }[] = [];
  const transcript = new Transcript(dom, root, (message) => sent.push(message), () => {}, () => {}, (id, text) => rewinds.push({ id, text }));
  return { window, dom, root, sent, rewinds, transcript };
}

test('transcript standalone row fallbacks remain usable before the first render', () => {
  const { window, root, sent, transcript } = bootTranscript();
  const host = root.appendChild(window.document.createElement('div'));
  const turn = {
    id: 'standalone', user: { id: 'standalone', text: 'draft', attachments: ['notes.txt'], canRewind: false },
    log: [], errors: [], done: true,
  };
  const internal = transcript as unknown as {
    renderUser(host: HTMLElement, value: typeof turn): void;
    editingTurnId: string | null;
    editingText: string;
  };
  internal.renderUser(host, turn);
  assert.equal(host.querySelector('.copy-user'), null);
  assert.equal(host.querySelector('.edit-user'), null);
  assert.equal(host.querySelector('.resend-user'), null);
  assert.equal(host.querySelector('.bubble')?.getAttribute('aria-label'), 'Edit message');

  internal.editingTurnId = 'standalone';
  internal.editingText = 'edit draft';
  internal.renderUser(host, turn);
  assert.equal(host.querySelector('.edit-prompt')?.getAttribute('aria-label'), 'Edit message');
  assert.equal(host.querySelector('.edit-attachments')?.getAttribute('aria-label'), 'Attachments');
  assert.equal(host.querySelector('[data-action="cancel-edit"] .btn-label')?.textContent, 'Cancel');
  assert.equal(host.querySelector('[data-action="rewind"] .btn-label')?.textContent, 'Return to input');
  assert.match(host.querySelector('[data-action="rewind"]')?.getAttribute('title') ?? '', /cannot be safely rewound/);
  assert.equal(host.querySelector('.edit-model .btn-label')?.textContent, 'Model');
  assert.equal(host.querySelector('.edit-model')?.classList.contains('is-static'), true);
  click(host.querySelector('[data-action="pick-session-model"]') as HTMLElement);
  assert.equal(sent.length, 0);
  host.querySelector('.edit-model')?.remove();
  internal.renderUser(host, turn);
  assert.equal(host.querySelector('.edit-model'), null);
  host.querySelector('.prompt-editor')?.remove();
  internal.renderUser(host, turn);
  click(host.querySelector('[data-action="rewind"]') as HTMLElement);
  assert.equal(posted(sent, 'prepareResend')?.id, 'standalone');

  transcript.render([
    { id: 'user', role: 'user', text: 'draft', at: 1 },
    { id: 'answer', role: 'assistant', text: 'body', at: 2, turnId: 'user', final: true },
  ], shell(), strings('en'));
  click(host.querySelector('[data-action="pick-session-model"]') as HTMLElement);
  const withLabels = transcript as unknown as { shell: ViewShell | null };
  withLabels.shell = null;
  internal.editingTurnId = 'standalone';
  internal.editingText = 'edit draft';
  internal.renderUser(host, turn);
  assert.equal(host.querySelector('.edit-model .btn-label')?.textContent, 'Model');
  const cleared = transcript as unknown as { labels: null; shell: null };
  cleared.labels = null;
  cleared.shell = null;
  click(root.querySelector('.copy-answer') as HTMLElement);
  let requestId = posted(sent, 'copy')?.requestId as string;
  transcript.copied(requestId, true);
  assert.equal(root.querySelector<HTMLButtonElement>('.copy-answer')?.title, 'Copied');
  click(root.querySelector('.copy-answer') as HTMLElement);
  requestId = posted(sent, 'copy')?.requestId as string;
  transcript.copied(requestId, false);
  assert.equal(root.querySelector<HTMLButtonElement>('.copy-answer')?.title, 'Copy failed');
  window.happyDOM.abort();
});
