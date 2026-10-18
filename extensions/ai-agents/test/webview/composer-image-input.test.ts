import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'Default model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'thread-1',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function planView(extra: Partial<ViewPlan> = {}): ViewPlan {
  return {
    id: 'plan-1', revision: 2, phase: 'ready', name: 'Plan', markdown: 'Plan body', todos: [], source: 'generated',
    buildModelId: 'build-alias', buildModelLabel: '', buildParams: [], showBuildModel: true, canBuild: true, history: [], ...extra,
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function bootComposer() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  return { window, document: window.document, dom, host, menu, composer, sent };
}

test('composer rejects an empty image-reader result and keeps the prompt intact', () => {
  const { window, host, composer, sent } = bootComposer();
  composer.render(shell(), strings('en'));
  composer.draft = 'keep this prompt';
  const internal = composer as unknown as { addImages(files: File[] | null): void };
  internal.addImages(null);
  assert.equal(host.querySelectorAll('.chips img').length, 0);

  const oldReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  class EmptyResultReader {
    result: string | null = null;
    onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null;
    readAsDataURL(_file: Blob): void { this.onload?.({} as ProgressEvent<FileReader>); }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: EmptyResultReader });
  try {
    internal.addImages([new window.File(['x'], 'empty.png', { type: 'image/png' })]);
  } finally {
    if (oldReader) Object.defineProperty(globalThis, 'FileReader', oldReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  }
  assert.equal(host.querySelectorAll('.chips img').length, 0);
  assert.equal(host.querySelector<HTMLElement>('.composer-error')?.hidden, false);
  click(host.querySelector('.send') as HTMLElement);
  const send = posted(sent, 'send');
  assert.equal(send?.prompt, 'keep this prompt');
  assert.deepEqual(send?.images, []);
  window.happyDOM.abort();
});

test('composer scopes image drafts to their conversation and restores them after reload', () => {
  const first = bootComposer();
  const image = { mimeType: 'image/png', data: 'aW1hZ2U=', name: 'fixture.png' };
  first.composer.render(shell(), strings('en'));
  first.composer.editDraft('retry this', 'retry-1');
  first.composer.restoreRetry('retry-1', 'retry this', [image]);
  assert.equal(first.host.querySelectorAll('.chips img').length, 1);

  first.composer.render(shell({ conversationId: 'thread-2' }), strings('en'));
  assert.equal(first.composer.draft, 'retry this', 'switching conversations keeps the text draft');
  assert.equal(first.host.querySelectorAll('.chips img').length, 0, 'an image is not exposed to another conversation');
  first.composer.render(shell(), strings('en'));
  assert.equal(first.host.querySelector('.chips img')?.getAttribute('alt'), 'fixture.png');

  const saved = first.composer.persistedAttachmentDrafts();
  const restored = bootComposer();
  restored.composer.restoreAttachmentDrafts(saved);
  restored.composer.render(shell(), strings('en'));
  assert.equal(restored.host.querySelector('.chips img')?.getAttribute('alt'), 'fixture.png');
  first.window.happyDOM.abort();
  restored.window.happyDOM.abort();
});

test('composer drops invalid persisted image bytes and asks for reattachment', () => {
  const { window, host, composer } = bootComposer();
  composer.restoreAttachmentDrafts({
    [['codex', '/workspace', 'thread-1', '', 'sdk'].join('\0')]: {
      images: [{ mimeType: 'image/svg+xml', data: '<svg/>' }], chips: [],
    },
  });
  composer.render(shell(), strings('en'));
  assert.equal(host.querySelectorAll('.chips img').length, 0);
  assert.match(host.querySelector<HTMLElement>('.composer-error')?.textContent ?? '', /attach it again/i);
  window.happyDOM.abort();
});

test('a late clipboard image read cannot enter the next conversation', () => {
  const { window, host, composer } = bootComposer();
  composer.render(shell(), strings('en'));
  const oldReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  let complete: (() => void) | undefined;
  class DeferredReader {
    result: string | null = null;
    onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((event: ProgressEvent<FileReader>) => unknown) | null = null;
    constructor() { pendingReader = this; }
    readAsDataURL(_file: Blob): void {
      complete = () => this.onload?.({} as ProgressEvent<FileReader>);
    }
  }
  let pendingReader: DeferredReader | undefined;
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: DeferredReader });
  try {
    (composer as unknown as { addImages(files: File[]): void }).addImages([
      new window.File(['old'], 'old.png', { type: 'image/png' }),
    ]);
    if (!pendingReader) throw new Error('the image reader was not created');
    pendingReader.result = 'data:image/png;base64,b2xk';
    composer.render(shell({ conversationId: 'thread-2' }), strings('en'));
    complete?.();
    assert.equal(host.querySelectorAll('.chips img').length, 0);
    assert.equal(host.querySelector<HTMLElement>('.composer-error')?.hidden, true);
  } finally {
    if (oldReader) Object.defineProperty(globalThis, 'FileReader', oldReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  }
  window.happyDOM.abort();
});
