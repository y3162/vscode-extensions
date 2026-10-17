import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';
import { Composer } from '../../src/webview/composer.js';
import { createDom } from '../../src/webview/dom.js';
import { Menu, ModelMenu } from '../../src/webview/popover.js';
import { SettingsPanel } from '../../src/webview/settings.js';
import { strings } from '../../src/webview/strings.js';
import { Transcript } from '../../src/webview/transcript.js';

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

test('composer distinguishes plan revision prompts and ignores an outdated scheduled suggestion', async () => {
  const { window, host, composer, sent } = bootComposer();
  composer.render(shell({
    mode: 'plan', conversationId: undefined, sessionId: undefined, terminals: undefined,
    planView: planView({ phase: 'revising' }),
  }), strings('en'));
  const input = host.querySelector<HTMLTextAreaElement>('#prompt')!;
  assert.equal(input.placeholder, strings('en').revisePlaceholder);
  assert.equal(host.querySelector('.terminals'), null);

  input.value = '@stale';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  composer.draft = 'regular prompt';
  await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  assert.equal(posted(sent, 'suggest'), undefined, 'clearing the caret token invalidates its pending timer');
  assert.equal(composer.draft, 'regular prompt');
  window.happyDOM.abort();
});

test('composer handles an empty image-reader result and null file list without corrupting the prompt', () => {
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
  assert.equal(host.querySelector<HTMLImageElement>('.chips img')?.src, 'data:image/png;base64,');
  click(host.querySelector('.send') as HTMLElement);
  const send = posted(sent, 'send');
  assert.equal(send?.prompt, 'keep this prompt');
  assert.deepEqual(send?.images, [{ mimeType: 'image/png', data: '', name: 'empty.png' }]);
  window.happyDOM.abort();
});

test('composer ignores detached suggestions and uses the textarea length if caret position is unavailable', () => {
  const { window, host, composer } = bootComposer();
  composer.render(shell(), strings('en'));
  const input = host.querySelector<HTMLTextAreaElement>('#prompt')!;
  const internal = composer as unknown as {
    suggestRequest: number;
    suggestToken: { kind: 'file'; query: string; start: number } | undefined;
    applySuggestion(item: { token: string } | undefined): void;
  };
  input.value = '@old';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  composer.setSuggestions(internal.suggestRequest, [{ label: 'old.ts', token: 'old.ts' }]);
  const staleButton = host.querySelector<HTMLButtonElement>('.suggest-item')!;
  composer.draft = 'replacement';
  staleButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  internal.applySuggestion(undefined);
  assert.equal(composer.draft, 'replacement', 'a removed suggestion cannot overwrite a newer draft');

  input.value = '@new';
  input.selectionStart = input.value.length;
  internal.suggestToken = { kind: 'file', query: 'new', start: 0 };
  composer.setSuggestions(internal.suggestRequest, [{ label: 'new.ts', token: 'new.ts' }]);
  Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
  host.querySelector<HTMLButtonElement>('.suggest-item')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(composer.draft, '@new.ts ', 'the fallback inserts at the current end of the prompt');
  window.happyDOM.abort();
});

test('composer pre-render guards avoid posting and expose plain-English model-list defaults', () => {
  const { window, composer, sent } = bootComposer();
  const internal = composer as unknown as {
    requestCatalog(refresh: boolean): void;
    setCatalog(message: ModelCatalogMessage): void;
    modelPage(): { items: unknown[] };
    modelListPage(catalog: ModelCatalogMessage): { backLabel?: string; search?: { placeholder: string; empty: string }; items: { label: string }[] };
    configure(extra: Record<string, string>): void;
  };
  internal.requestCatalog(false);
  internal.setCatalog({ type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId: 1, status: 'ready', models: [], selectedModelId: '', selectedParams: [] });
  internal.configure({ mode: 'plan' });
  assert.deepEqual(sent, [], 'catalog and configure requests require a rendered shell');
  assert.deepEqual(internal.modelPage(), { items: [] });
  const fallback = internal.modelListPage({ type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId: 1, status: 'ready', models: [], selectedModelId: '', selectedParams: [] });
  assert.deepEqual(fallback.search, { placeholder: 'Search models', empty: 'No matching models' });
  assert.equal(fallback.items.at(-1)?.label, 'Refresh');
  window.happyDOM.abort();
});

test('build model menu applies build parameters and selects an alias-backed model', () => {
  const { window, document, host, composer, sent } = bootComposer();
  composer.render(shell({ planView: planView({ buildParams: [{ id: 'fast', value: 'on' }] }) }), strings('en'));
  const anchor = host.querySelector<HTMLElement>('.model-name')!;
  composer.openBuildModel(anchor);
  const requestId = posted(sent, 'loadModelCatalog')?.requestId as number;
  const parameterCatalog: ModelCatalogMessage = {
    type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId, status: 'ready',
    selectedModelId: 'build-alias', selectedParams: [{ id: 'fast', value: 'on' }], models: [{
      id: 'build-model', label: '', aliases: ['build-alias'], parameters: [
        { id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
        { id: 'extra', label: 'Extra', role: 'other', presentation: 'menu', values: [{ value: 'one', label: 'One' }] },
      ],
    }],
  };
  composer.setCatalog(parameterCatalog);
  assert.equal(document.querySelector('.model-menu [data-id="model"] .menu-value')?.textContent, 'Default model');
  assert.equal(document.querySelector('.model-menu [data-id="extra"] .menu-value'), null, 'an unset parameter has no value label to render');
  click(document.querySelector('.model-menu [data-id="fast"]') as HTMLElement);
  assert.equal(posted(sent, 'setBuildParam')?.value, 'off', 'the selected default-on toggle turns off');

  composer.openBuildModel(anchor);
  composer.setCatalog(parameterCatalog);
  click(document.querySelector('.model-menu [data-id="model"]') as HTMLElement);
  const aliasItem = document.querySelector<HTMLButtonElement>('.model-menu [data-id="model:build-model"]')!;
  assert.equal(aliasItem.getAttribute('aria-checked'), 'true');
  click(aliasItem);
  assert.equal(posted(sent, 'setBuildModel')?.modelId, 'build-model');

  click(host.querySelector('.model-name') as HTMLElement);
  const regularRequestId = posted(sent, 'loadModelCatalog')?.requestId as number;
  composer.setCatalog({ ...parameterCatalog, requestId: regularRequestId, selectedModelId: 'build-model', selectedParams: [{ id: 'fast', value: 'on' }] });
  click(document.querySelector('.model-menu [data-id="fast"]') as HTMLElement);
  assert.equal(posted(sent, 'setModelParam')?.value, 'off', 'the regular model menu uses the session parameter route');
  window.happyDOM.abort();
});

test('popover wraps ArrowUp, ignores keys after close, and safely handles a targetless synthetic pointer event', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  root.append(trigger);
  window.document.body.append(root);
  const menu = new Menu(dom, root);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);
  const pointer = menu as unknown as { onPointer(event: Event): void };
  pointer.onPointer(new window.Event('pointerdown'));
  assert.equal(menu.isOpen, true, 'an undispatched event has no target and cannot close the menu');
  menu.close(false);
  const hiddenKey = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  menu.element.dispatchEvent(hiddenKey);
  assert.equal(hiddenKey.defaultPrevented, false);

  const model = new ModelMenu(dom, root);
  model.open(trigger, { items: [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'last', label: 'Last', onSelect() {} },
  ] });
  model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(model.element.querySelector('[data-id="last"]')?.classList.contains('active'), true);
  const modelPointer = model as unknown as { onPointer(event: Event): void };
  modelPointer.onPointer(new window.Event('pointerdown'));
  assert.equal(model.isOpen, true);
  model.close(false);
  const hiddenModelKey = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  model.element.dispatchEvent(hiddenModelKey);
  assert.equal(hiddenModelKey.defaultPrevented, false);
  window.happyDOM.abort();
});

test('settings rejects pre-render changes and only posts after applying a rendered selection', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  window.document.body.append(root);
  const sent: unknown[] = [];
  const settings = new SettingsPanel(dom, root, (message) => sent.push(message), () => {});
  const internal = settings as unknown as { changed(key: string, value: string | boolean): void; applying: boolean };
  internal.changed('sandbox', 'danger-full-access');
  assert.deepEqual(sent, [], 'a panel without a shell cannot submit a configuration');

  settings.render(shell(), strings('en'));
  internal.applying = true;
  internal.changed('sandbox', 'danger-full-access');
  assert.deepEqual(sent, [], 'an update while the form is applying is ignored');
  internal.applying = false;
  const sandbox = root.querySelector<HTMLSelectElement>('select[data-key="sandbox"]')!;
  sandbox.value = 'workspace-write';
  sandbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.sandbox, 'workspace-write');
  window.happyDOM.abort();
});

test('transcript restores pending placement, handles stale rewinds, copy outcomes, and shell-output fallback', () => {
  const { window, root, sent, rewinds, transcript } = bootTranscript();
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'prompt', canRewind: true },
    { id: 'tool-1', role: 'tool', text: 'plain command output', turnId: 'user-1', tool: { name: 'Run', kind: 'shell', status: 'completed', target: 'echo hi' } },
    { id: 'tool-2', role: 'tool', text: 'completed: command succeeded', turnId: 'user-1', tool: { name: 'Run', kind: 'shell', status: 'completed', target: 'true' } },
    { id: 'error-1', role: 'error', text: 'failed', turnId: 'user-1' },
  ];
  transcript.render(messages, shell({ busy: true, timings: undefined }), strings('en'));
  const article = root.querySelector<HTMLElement>('[data-id="user-1"]')!;
  assert.equal(article.querySelector('.log-toggle .btn-label')?.textContent, strings('en').working);
  click(article.querySelector('.shell-tool-heading') as HTMLElement);
  assert.equal(article.querySelector('.shell-command-output')?.textContent, 'plain command output');
  click(article.querySelector('.shell-tool-heading') as HTMLElement);
  assert.equal(article.querySelector('.shell-command-output'), null, 'the second toggle closes the open details');
  const statusTool = root.querySelector<HTMLElement>('.shell-tool-heading[data-id="tool-2"]')!;
  click(statusTool);
  assert.equal(statusTool.closest('.tool-row-item')?.querySelector('.shell-command-output'), null, 'a status-only single-line result has no duplicate output block');
  click(statusTool);

  transcript.render(messages, shell({ busy: false, timings: undefined }), strings('en'));
  const edit = article.querySelector<HTMLButtonElement>('.edit-user')!;
  assert.equal(edit.disabled, false, 'the same prompt becomes editable again after the session stops');
  click(edit);
  const textarea = article.querySelector<HTMLTextAreaElement>('.edit-prompt')!;
  textarea.value = 'edited before detach';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  textarea.remove();
  click(article.querySelector('[data-action="rewind"]') as HTMLElement);
  assert.deepEqual(rewinds, [{ id: 'user-1', text: 'edited before detach' }], 'rewind uses cached text if its editor was detached');

  const copySource = article.querySelector<HTMLButtonElement>('.copy-user')!;
  click(copySource);
  const copyRequest = posted(sent, 'copy')?.requestId as string;
  transcript.copied(copyRequest, false);
  assert.equal(copySource.title, 'Copy failed');
  const logAction = root.querySelector<HTMLButtonElement>('[data-action="post"]');
  assert.ok(logAction);
  click(logAction);
  assert.ok(sent.some((message) => (message as { type?: string }).type === 'logs' || (message as { type?: string }).type === 'diagnose'));
  const malformedAction = window.document.createElement('button');
  malformedAction.dataset.action = 'post';
  root.append(malformedAction);
  const sentBeforeMalformedAction = sent.length;
  click(malformedAction);
  assert.equal(sent.length, sentBeforeMalformedAction, 'post actions without a type are ignored');

  const pending = root.querySelector('.pending')!;
  pending.remove();
  transcript.render(messages, shell({ busy: true, timings: undefined }), strings('en'));
  assert.equal(root.lastElementChild, pending, 'render reattaches a detached pending host');
  window.happyDOM.abort();
});

test('plan view uses its localized model label when the selected build label is empty', () => {
  const { window, root, transcript } = bootTranscript();
  transcript.render([], shell({ planView: planView({ buildModelLabel: '' }) }), strings('en'));
  assert.equal(root.querySelector('.plan-actions .pill .btn-label')?.textContent, strings('en').model);
  window.happyDOM.abort();
});

test('transcript refuses edits while busy and memoizes an unchanged file preview', () => {
  const { window, root, transcript } = bootTranscript();
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'prompt', canRewind: true },
    { id: 'files-1', role: 'tool', text: 'files changed', turnId: 'user-1', meta: {
      type: 'files', files: [{ path: 'src/a.ts', kind: 'update', preview: [{ kind: 'context', line: 1, text: 'unchanged' }] }],
    } },
  ];
  transcript.render(messages, shell({ busy: true }), strings('en'));
  const edit = root.querySelector<HTMLButtonElement>('.edit-user')!;
  click(edit);
  assert.equal(root.querySelector('.edit-prompt'), null, 'a busy conversation cannot enter rewind editing');
  const previewLine = root.querySelector('.diff-preview-line');
  transcript.render(structuredClone(messages), shell({ busy: true }), strings('en'));
  assert.equal(root.querySelector('.diff-preview-line'), previewLine, 'identical preview lines retain their rendered node');
  window.happyDOM.abort();
});

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
