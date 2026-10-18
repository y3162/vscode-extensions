import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { Transcript } from '../../src/webview/transcript.js';

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
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
  assert.equal(host.querySelector('.copy-user')?.getAttribute('aria-label'), 'Copy');
  assert.equal(host.querySelector('.edit-user')?.title, 'This turn cannot be safely rewound.');
  click(host.querySelector('.copy-user') as HTMLElement);
  let requestId = posted(sent, 'copy')?.requestId as string;
  transcript.copied(requestId, true);
  assert.equal(host.querySelector<HTMLButtonElement>('.copy-user')?.title, 'Copied');
  click(host.querySelector('.copy-user') as HTMLElement);
  requestId = posted(sent, 'copy')?.requestId as string;
  transcript.copied(requestId, false);
  assert.equal(host.querySelector<HTMLButtonElement>('.copy-user')?.title, 'Copy failed');

  internal.editingTurnId = 'standalone';
  internal.editingText = 'edit draft';
  internal.renderUser(host, turn);
  assert.equal(host.querySelector('.edit-prompt')?.getAttribute('aria-label'), 'Edit message');
  assert.equal(host.querySelector('.edit-attachments')?.getAttribute('aria-label'), 'Attachments');
  assert.equal(host.querySelector('[data-action="cancel-edit"] .btn-label')?.textContent, 'Cancel');
  assert.equal(host.querySelector('[data-action="rewind"] .btn-label')?.textContent, 'Resend');
  window.happyDOM.abort();
});
