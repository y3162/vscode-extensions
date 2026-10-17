import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { ModelCatalogMessage, ViewMessage, ViewShell } from '../../src/protocol.js';
import { Composer } from '../../src/webview/composer.js';
import { createDom } from '../../src/webview/dom.js';
import { Menu } from '../../src/webview/popover.js';
import { strings } from '../../src/webview/strings.js';
import { Transcript } from '../../src/webview/transcript.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'Chat', modelLabel: 'Model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [], modes: [{ id: 'agent', label: 'Agent' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'conversation',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function bootComposer() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  return { window, host, composer, sent };
}

function bootTranscript() {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  return { window, root, transcript };
}

test('composer defaults a missing caret to position zero and discards an already-queued stale suggestion callback', async () => {
  const { window, host, composer, sent } = bootComposer();
  composer.render(shell(), strings('en'));
  const input = host.querySelector<HTMLTextAreaElement>('#prompt')!;
  Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
  input.value = '@file';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  assert.equal(sent.some((message) => (message as { type?: string }).type === 'suggest'), false, 'caret zero is before the @ token');

  const clear = window.clearTimeout.bind(window);
  window.clearTimeout = (() => undefined) as typeof window.clearTimeout;
  try {
    Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => input.value.length });
    input.value = '@queued';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    composer.draft = 'new prompt';
    await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
  } finally {
    window.clearTimeout = clear;
  }
  assert.equal(sent.some((message) => (message as { type?: string }).type === 'suggest'), false, 'an expired request ID cannot publish after its token is cleared');
  window.happyDOM.abort();
});

test('regular model parameter submenu selects through the session parameter message', () => {
  const { window, host, composer, sent } = bootComposer();
  composer.render(shell(), strings('en'));
  click(host.querySelector('.model-name') as HTMLElement);
  const requestId = (sent.at(-1) as { requestId: number }).requestId;
  const catalog: ModelCatalogMessage = {
    type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId, status: 'ready',
    selectedModelId: 'model-a', selectedParams: [{ id: 'effort', value: 'low' }],
    models: [{ id: 'model-a', label: 'Model A', parameters: [{
      id: 'effort', label: 'Effort', role: 'effort', presentation: 'menu',
      values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    }] }],
  };
  composer.setCatalog(catalog);
  click(host.querySelector('.model-menu [data-id="effort"]') as HTMLElement);
  click(host.querySelector('.model-menu [data-id="effort:high"]') as HTMLElement);
  const update = [...sent].reverse().find((item) => (item as { type?: string }).type === 'setModelParam') as Record<string, unknown> | undefined;
  assert.deepEqual({ type: update?.type, id: update?.id, value: update?.value }, { type: 'setModelParam', id: 'effort', value: 'high' });
  window.happyDOM.abort();
});

test('menu ArrowUp moves from the second entry back to the first', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('div');
  const trigger = dom.button('trigger', 'Open');
  root.append(trigger);
  window.document.body.append(root);
  const menu = new Menu(dom, root);
  menu.open(trigger, [
    { id: 'first', label: 'First', onSelect() {} },
    { id: 'second', label: 'Second', onSelect() {} },
  ]);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="second"]')?.classList.contains('active'), true);
  menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(menu.element.querySelector('[data-id="first"]')?.classList.contains('active'), true);
  menu.close(false);
  window.happyDOM.abort();
});

test('transcript rejects a busy rewind event and safely skips refresh before labels are ready', () => {
  const { window, root, transcript } = bootTranscript();
  const internal = transcript as unknown as { shell: ViewShell | null; labels: null; refreshOpenTurn(): void };
  internal.refreshOpenTurn();
  internal.shell = shell();
  internal.refreshOpenTurn();

  transcript.render([{ id: 'user-1', role: 'user', text: 'prompt', canRewind: true }], shell({ busy: true }), strings('en'));
  const edit = root.querySelector<HTMLButtonElement>('.edit-user')!;
  edit.disabled = false; // Dispatch through the listener while retaining the busy shell state.
  click(edit);
  assert.equal(root.querySelector('.edit-prompt'), null, 'a stale or synthetic edit click cannot start rewind while busy');
  window.happyDOM.abort();
});

test('transcript replaces a same-size changed file preview and labels a running tool', () => {
  const { window, root, transcript } = bootTranscript();
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'inspect' },
    { id: 'file-1', role: 'tool', text: 'changed', turnId: 'user-1', meta: {
      type: 'files', files: [{ path: 'src/a.ts', kind: 'update', preview: [{ kind: 'context', line: 1, text: 'before' }] }],
    } },
  ];
  transcript.render(messages, shell(), strings('en'));
  const previousLine = root.querySelector('.diff-preview-line');
  const updated = structuredClone(messages);
  const fileMessage = updated[1];
  assert.equal(fileMessage?.meta?.type, 'files');
  if (fileMessage?.meta?.type === 'files') fileMessage.meta.files[0]!.preview![0]!.text = 'after';
  transcript.render(updated, shell(), strings('en'));
  assert.notEqual(root.querySelector('.diff-preview-line'), previousLine);
  assert.equal(root.querySelector('.diff-preview-line code')?.textContent, 'after');

  transcript.render([
    { id: 'user-2', role: 'user', text: 'run' },
    { id: 'running-tool', role: 'tool', text: 'running', turnId: 'user-2', tool: { name: 'Search', kind: 'search', status: 'running' } },
  ], shell({ busy: true }), strings('en'));
  assert.equal(root.querySelector('.log-toggle .btn-label')?.textContent, 'Search…');
  window.happyDOM.abort();
});
