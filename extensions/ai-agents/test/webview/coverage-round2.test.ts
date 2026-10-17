import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { buildTurns } from '../../src/webview/turns.js';
import { createApp } from '../../src/webview/app.js';
import { Composer } from '../../src/webview/composer.js';
import { createDom } from '../../src/webview/dom.js';
import { Menu, ModelMenu } from '../../src/webview/popover.js';
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

test('app falls back to body without #app, drops removed IDs, and skips dangling message order IDs', () => {
  const detached = new Window();
  const emptySent: unknown[] = [];
  const emptyApp = createApp({
    postMessage(message) { emptySent.push(message); }, getState: () => null, setState() {},
  }, { document: detached.document });
  assert.equal(detached.document.body.classList.contains('shell'), true);
  assert.equal(posted(emptySent, 'ready')?.type, 'ready');
  emptyApp.destroy();

  const { window, document, app, emit } = bootApp();
  const user = { id: 'user-1', role: 'user' as const, text: 'visible prompt', at: 1 };
  emit(shell(), { upserts: [user], order: ['user-1'] });
  assert.equal(document.querySelector('[data-id="user-1"]')?.textContent?.includes('visible prompt'), true);
  emit(shell(), { full: false, removed: ['user-1'], order: ['stale-id'] });
  assert.equal(document.querySelector('[data-id="user-1"]'), null);
  assert.equal(document.querySelector('.turn'), null);
  assert.ok(document.querySelector('.empty'));
  app.destroy();
  window.happyDOM.abort();
});

test('app uses global event hooks when given a document without a window', () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument('detached');
  const oldAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const oldRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  const added: string[] = [];
  const removed: string[] = [];
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: (type: string) => added.push(type) });
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: (type: string) => removed.push(type) });
  try {
    const app = createApp({ postMessage() {}, getState: () => null, setState() {} }, { document });
    assert.deepEqual(added, ['keydown', 'message']);
    app.destroy();
    assert.deepEqual(removed, ['keydown', 'message']);
  } finally {
    if (oldAdd) Object.defineProperty(globalThis, 'addEventListener', oldAdd);
    else Reflect.deleteProperty(globalThis, 'addEventListener');
    if (oldRemove) Object.defineProperty(globalThis, 'removeEventListener', oldRemove);
    else Reflect.deleteProperty(globalThis, 'removeEventListener');
    sourceWindow.happyDOM.abort();
  }
});

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

test('composer invalidates catalogs across workspace changes and keeps fallbacks visible', () => {
  const { window, document, host, composer, sent } = bootComposer();
  composer.render(shell(), strings('en'));
  click(host.querySelector('.model-name') as HTMLElement);
  const firstRequest = posted(sent, 'loadModelCatalog')?.requestId as number;
  const failed: ModelCatalogMessage = {
    type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId: firstRequest,
    status: 'error', models: [], selectedModelId: '', selectedParams: [], error: '',
  };
  composer.setCatalog(failed);
  assert.match(document.querySelector('.model-menu')?.textContent ?? '', /Could not load models/);

  composer.render(shell({ cwd: '/other', folderName: 'other' }), strings('en'));
  click(host.querySelector('.model-name') as HTMLElement);
  const currentRequest = posted(sent, 'loadModelCatalog')?.requestId as number;
  assert.ok(currentRequest > firstRequest);
  assert.match(document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);
  composer.setCatalog({ ...failed, requestId: firstRequest, status: 'ready' });
  assert.match(document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);

  composer.setCatalog({
    type: 'modelCatalog', provider: 'codex', cwd: '/other', requestId: currentRequest,
    status: 'ready', selectedModelId: 'alias', selectedParams: [{ id: 'effort', value: 'unsupported' }],
    models: [{
      id: 'model-1', label: 'Model One', aliases: ['alias'], parameters: [{
        id: 'effort', label: 'Effort', role: 'effort', presentation: 'menu',
        values: [{ value: 'low', label: 'Low' }],
      }],
    }],
  });
  assert.equal(document.querySelector('.menu-item[data-id="effort"] .menu-value')?.textContent, 'unsupported');
  click(document.querySelector('.menu-item[data-id="model"]') as HTMLElement);
  assert.equal(document.querySelector('.menu-item[data-id="model:model-1"]')?.getAttribute('aria-checked'), 'true');
  window.happyDOM.abort();
});

test('composer uses the mode label fallback and renders terminal id fallbacks', () => {
  const { window, document, host, composer } = bootComposer();
  composer.render(shell({
    mode: 'custom-mode', modes: [], showMode: true,
    terminals: [{ processId: 'pid-empty', command: '', status: '' }, { processId: 'pid-running', command: '', status: 'running' }],
  }), strings('en'));
  assert.equal(host.querySelector('.mode .btn-label')?.textContent, 'custom-mode');
  assert.deepEqual([...document.querySelectorAll('.terminal-open .btn-label')].map((node) => node.textContent), ['pid-empty', 'pid-running']);
  assert.equal(document.querySelectorAll('.terminal-state').length, 1);
  window.happyDOM.abort();
});

test('composer remains usable without a document window or animation timer', () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument('detached');
  const dom = createDom(document);
  const host = dom.el('div');
  document.body.append(host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), new Menu(dom, host), () => {});
  composer.render(shell(), strings('en'));
  const input = document.querySelector<HTMLTextAreaElement>('#prompt')!;
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 500 });
  input.value = '@file';
  input.selectionStart = input.value.length;
  const event = new sourceWindow.Event('input', { bubbles: true });
  input.dispatchEvent(event);
  assert.equal(input.style.height, '320px');
  assert.equal(host.querySelector('.suggest')?.hasAttribute('hidden'), true);
  assert.equal(posted(sent, 'suggest'), undefined);
  sourceWindow.happyDOM.abort();
});

test('model menu wraps focus and drills when both sides lack room at a normal viewport width', () => {
  const window = new Window();
  window.innerWidth = 800;
  const dom = createDom(window.document);
  const host = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  host.append(trigger);
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="first"]')?.classList.contains('active'), true);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);

  const model = new ModelMenu(dom, host);
  model.open(trigger, { items: [{ id: 'more', label: 'More', submenu: () => ({ items: [{ id: 'child', label: 'Child' }] }) }] });
  Object.defineProperty(model.element, 'getBoundingClientRect', { value: () => ({ left: 150, right: 700, top: 560, bottom: 590, width: 550, height: 30 }) });
  model.element.querySelector<HTMLButtonElement>('[data-id="more"]')!.click();
  assert.equal(model.element.querySelector('[data-id="back"] .menu-label')?.textContent, 'Back');
  assert.equal(model.element.querySelector('.menu-back') !== null, true);
  assert.equal((host.querySelector('.submenu') as HTMLElement).hidden, true);
  model.close(false);
  model.element.remove();
  host.querySelector('.submenu')?.remove();

  const overflow = new ModelMenu(dom, host);
  overflow.open(trigger, { items: [{ id: 'more', label: 'More', submenu: () => ({ items: [{ id: 'child', label: 'Child' }] }) }] });
  Object.defineProperty(overflow.element, 'getBoundingClientRect', { value: () => ({ left: 600, right: 790, top: 20, bottom: 50, width: 190, height: 30 }) });
  overflow.element.querySelector<HTMLButtonElement>('[data-id="more"]')!.click();
  assert.equal((host.querySelector('.submenu') as HTMLElement).hidden, false);
  assert.equal((host.querySelector('.submenu') as HTMLElement).style.left, '376px');
  overflow.close(false);
  menu.close(false);
  window.happyDOM.abort();
});

test('turn grouping keeps empty tool names, absent timestamps, and backend timing overrides', () => {
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'prompt' },
    { id: 'plain-tool', role: 'tool', text: 'raw detail' },
    { id: 'empty-tool', role: 'tool', text: 'Custom:   ' },
    { id: 'answer', role: 'assistant', text: 'done', final: true },
  ];
  const [turn] = buildTurns(messages, false, false, [{
    id: 'user-1', startedAt: 10, endedAt: 20, waitMs: 3, status: 'completed', intent: 'chat',
  }]);
  assert.equal(turn?.user?.at, undefined);
  assert.equal(turn?.startedAt, 10);
  assert.equal(turn?.endedAt, 20);
  assert.deepEqual(turn?.log.filter((segment) => segment.type === 'tools').flatMap((segment) => segment.tools.map((tool) => tool.name)), [
    'raw detail', 'Custom:   ',
  ]);
  assert.equal(turn?.answer?.text, 'done');
});

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

test('transcript uses live thinking duration and renders a file row with no preview', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  const start = Date.now() - 1400;
  transcript.render([
    { id: 'user', role: 'user', text: 'checking', at: start },
    { id: 'thinking', role: 'status', text: 'working', at: start, turnId: 'user', meta: { type: 'thinking' } },
  ], shell({ busy: true }), strings('en'));
  assert.match(root.querySelector('.thought-toggle .btn-label')?.textContent ?? '', /Thought 1s/);

  transcript.render([
    { id: 'user', role: 'user', text: 'file change' },
    { id: 'files', role: 'tool', text: 'changed', turnId: 'user', meta: { type: 'files', files: [{ path: 'src/a.ts', kind: 'update' }] } },
  ], shell(), strings('en'));
  assert.equal(root.querySelectorAll('.file-row').length, 1);
  assert.equal(root.querySelector('.file-inline-diff'), null);
  window.happyDOM.abort();
});

