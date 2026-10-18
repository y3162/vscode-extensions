import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

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

function bootComposer(options: { detachMenu?: boolean } = {}) {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  if (options.detachMenu) menu.element.remove();
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  return { window, document: window.document, dom, host, menu, composer, sent };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

test('composer safely handles missing clipboard data and restores unnamed image attachments once', () => {
  const { window, document, host, composer, sent, menu } = bootComposer({ detachMenu: true });
  assert.equal(host.querySelector('.model-menu')?.parentElement, host, 'a detached mode menu falls back to the composer host');
  composer.render(shell(), strings('en'));
  composer.editDraft('retry this', 'retry-1');
  const paste = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: null });
  document.querySelector('#prompt')!.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);

  composer.restoreRetry('other-retry', 'other', [], ['wrong']);
  composer.restoreRetry('retry-1', 'retry this', [{ mimeType: 'image/png', data: 'YQ==' }], ['image', 'notes.md']);
  assert.equal(document.querySelectorAll('.chips .chip').length, 2);
  assert.equal(document.querySelector('.chips img')?.getAttribute('alt'), 'image');
  const removeNote = document.querySelector<HTMLButtonElement>('.chips .chip button')!;
  click(removeNote);
  assert.equal(composer.draft, 'retry this', 'an attachment-only chip does not edit the prompt');
  click(removeNote); // A detached stale chip callback must be harmless after the first removal.
  assert.equal(document.querySelectorAll('.chips .chip').length, 1);

  click(host.querySelector('.send') as HTMLElement);
  const send = posted(sent, 'send');
  assert.deepEqual(send?.attachments, ['image']);
  assert.equal((send?.images as unknown[])?.length, 1);
  menu.close(false);
  window.happyDOM.abort();
});
