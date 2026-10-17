import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createApp } from '../../src/webview/app.js';
import { Composer } from '../../src/webview/composer.js';
import { createDom } from '../../src/webview/dom.js';
import { Menu } from '../../src/webview/popover.js';
import { strings } from '../../src/webview/strings.js';
import { Transcript } from '../../src/webview/transcript.js';
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

function countType(sent: unknown[], type: string): number {
  return sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === type).length;
}

function boot(saved?: unknown) {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  let persisted: unknown = saved ?? null;
  const vscode: VsCodeApi = {
    postMessage(message) { sent.push(message); },
    getState: () => persisted,
    setState(state) { persisted = state; },
  };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  const input = () => window.document.querySelector('#prompt') as HTMLTextAreaElement;
  return { window, sent, app, emit, persisted: () => persisted, input, document: window.document };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function key(node: HTMLElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new node.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
}

const catalog = {
  type: 'modelCatalog', provider: 'codex', cwd: '/workspace', status: 'ready',
  selectedModelId: 'gpt-6', selectedParams: [{ id: 'modelReasoningEffort', value: 'low' }],
  models: [
    { id: '', label: 'Skipped', parameters: [] },
    {
      id: 'gpt-6', label: 'GPT-6', aliases: ['sol'], description: 'Balanced',
      parameters: [
        { id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] },
        { id: 'broken', label: 'Broken', role: 'fast', presentation: 'toggle', values: [{ value: 'low', label: 'Low' }] },
        {
          id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu', defaultValue: 'low',
          values: [{ value: 'low', label: 'Low', description: 'Quick' }, { value: 'high', label: 'High' }],
        },
      ],
    },
    { id: 'other', label: 'Other', parameters: [] },
  ],
};

test('actions before the first shell do not post agent commands', () => {
  const { window, sent, document } = boot();
  for (const selector of ['.provider', '.mode', '.attach', '.env', '.open-terminals', '.send']) click(document.querySelector(selector)!);
  assert.equal(posted(sent, 'select'), undefined);
  assert.equal(posted(sent, 'configure'), undefined);
  assert.equal(posted(sent, 'attach'), undefined);
  assert.equal(posted(sent, 'openTerminal'), undefined);
  assert.equal(posted(sent, 'send'), undefined);
  assert.equal(document.querySelector('.menu')?.hidden, true);
  click(document.querySelector('.new-chat')!);
  const created = posted(sent, 'newChat');
  assert.equal(created?.type, 'newChat');
  assert.equal('provider' in (created ?? {}), false);
  assert.equal(document.getElementById('app')?.dataset.page, 'chat');
  assert.equal(window.document.querySelector('#prompt'), document.activeElement);
});

test('host state is painted immediately when the browser has no animation-frame API', () => {
  const { window, document } = boot();
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: undefined });
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'state', revision: 1, full: true, shell: shell({ sessionTitle: 'Synchronous update' }),
      messages: { removed: [], upserts: [], order: [] },
    },
  }));
  assert.equal(document.querySelector('.title-pill')?.textContent, 'Synchronous update');
});

test('host messages show errors, inspectors, navigation, and probes without inventing commands', () => {
  const { window, sent, emit, document, app } = boot();
  emit(shell({ sessionTitle: 'Alpha', sessions: [{ id: 'a', title: 'Alpha', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' }] }), [
    { id: 'user', role: 'user', text: 'hi', at: 1 },
  ]);
  click(visible(document, '.new-chat'));
  window.dispatchEvent(new window.MessageEvent('message', { data: null }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { nope: true } }));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'error', text: 'connection lost' } }));
  const alert = document.querySelector('.host-error') as HTMLElement;
  assert.equal(alert.hidden, false);
  assert.equal(alert.textContent, 'connection lost');
  assert.equal(posted(sent, 'send'), undefined);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'inspector', title: 'Diagnostics', text: 'all good' } }));
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  assert.equal(document.querySelector('.inspector h3')?.textContent, 'Diagnostics');
  assert.match(document.querySelector('.inspector pre')?.textContent ?? '', /all good/);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'chat' } }));
  assert.equal(alert.hidden, true);
  assert.equal(document.querySelector('.settings-panel')?.hidden, true);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'settings' } }));
  click(document.querySelector('.provider')!);
  key(document.body, 'Escape');
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  key(document.body, 'Escape');
  assert.equal(document.querySelector('.settings-panel')?.hidden, true);
  const before = countType(sent, 'refreshSessions');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'navigate', panel: 'history' } }));
  assert.equal(document.getElementById('app')?.dataset.page, 'home');
  assert.equal(countType(sent, 'refreshSessions'), before + 1);
  const kept = [{ id: 'a', title: 'Alpha', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' as const }];
  const keptMessages = [{ id: 'user', role: 'user' as const, text: 'hi', at: 1 }];
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 2, full: true, shell: shell({ sessionTitle: 'First', sessions: kept }), messages: { removed: [], upserts: keptMessages, order: ['user'] } },
  }));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'state', revision: 3, full: true, shell: shell({ sessionTitle: 'Second', sessions: kept }), messages: { removed: [], upserts: keptMessages, order: ['user'] } },
  }));
  app.flush();
  assert.equal(document.querySelector('.title-pill')?.textContent, 'Second');
  click(visible(document, '[data-session-id="a"]'));
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'probe' } }));
  const probe = posted(sent, 'probeResult');
  assert.equal(probe?.turns, 1);
  assert.equal(probe?.pending, false);
  assert.equal(probe?.history, false);
  assert.equal(probe?.settings, false);
  assert.equal('provider' in (probe ?? {}), false);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: 'missing', ok: true } }));
  assert.equal(posted(sent, 'copy'), undefined);
});

test('a restored webview keeps the draft, the open log, and an unstuck thread', () => {
  const { window, emit, document, input } = boot({ draft: 'saved draft', expanded: ['user'], stick: false, page: 'chat' });
  const thread = document.querySelector('.thread') as HTMLElement;
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(thread, 'scrollTop', { configurable: true, writable: true, value: 0 });
  emit(shell({ locale: 'ja', sessionTitle: '保存済み' }), [
    { id: 'user', role: 'user', text: '質問', at: 1 },
    { id: 'note', role: 'status', text: 'メモ', at: 2, turnId: 'user' },
    { id: 'answer', role: 'assistant', text: '答え', at: 3, turnId: 'user', final: true },
  ]);
  assert.equal(document.getElementById('app')?.dataset.page, 'chat');
  assert.equal(input().value, 'saved draft');
  assert.equal(input().placeholder, strings('ja').placeholder);
  assert.equal(document.documentElement.lang, 'ja');
  assert.equal(document.querySelector('.log')?.hidden, false);
  const jump = document.querySelector('.jump') as HTMLElement;
  assert.equal(jump.hidden, false);
  thread.dispatchEvent(new window.Event('scroll'));
  assert.equal(jump.hidden, false);
  click(jump);
  assert.equal(jump.hidden, true);
  assert.equal(thread.scrollTop, 1000);
});

test('history shows activity, empty titles, and the conversation id that was clicked', () => {
  const { sent, emit, document } = boot();
  emit(shell({
    sessionId: 'current',
    presence: 'waiting',
    providers: [],
    provider: 'cursor',
    sessions: [
      { id: 'old', title: '', updatedAt: '2026-10-14T00:00:00.000Z', provider: 'codex', activity: 'idle' },
      { id: 'current', conversationId: 'conv-current', title: 'Current', updatedAt: '2026-10-15T00:00:00.000Z', provider: 'codex', activity: 'idle' },
      { id: 'live', conversationId: 'conv-live', title: 'Live', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex', activity: 'running' },
    ],
  }));
  assert.equal(document.querySelector('.provider .btn-label')?.textContent, 'Cursor');
  assert.deepEqual([...document.querySelectorAll('.session-name')].map((node) => node.textContent), ['Live', 'Current', 'old']);
  assert.match(document.querySelector('[data-session-id="live"] .presence')?.className ?? '', /running/);
  assert.match(document.querySelector('[data-session-id="current"] .presence')?.className ?? '', /waiting/);
  assert.equal(document.querySelector('[data-session-id="old"] .presence'), null);
  click(document.querySelector('[data-session-id="live"]')!);
  assert.equal(posted(sent, 'restoreSession')?.id, 'conv-live');
  emit(shell({
    provider: 'codex', providers: [], sessionId: 'same', presence: 'error',
    sessions: [{ id: 'same', title: 'Same', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' }],
  }));
  assert.equal(document.querySelector('.provider .btn-label')?.textContent, 'Codex');
  assert.equal(document.querySelector('[data-session-id="same"] .presence'), null);
  const before = countType(sent, 'restoreSession');
  emit(shell({
    sessionId: 'current', presence: 'running',
    sessions: [
      { id: 'current', title: 'Current', updatedAt: '2026-10-16T00:00:00.000Z', provider: 'codex' },
      { id: 'other', title: 'Other', updatedAt: '2026-10-15T00:00:00.000Z', provider: 'codex' },
    ],
  }));
  windowNull(document, sent);
  click(document.querySelector('[data-session-id="other"]')!);
  assert.equal(countType(sent, 'restoreSession'), before);
});

function windowNull(document: Document, sent: unknown[]): void {
  document.defaultView?.dispatchEvent(new document.defaultView.MessageEvent('message', {
    data: { type: 'state', revision: 9, full: false, shell: null, messages: { removed: [], upserts: [], order: [] } },
  }));
  void sent;
}

test('settings changes approval, search, network, directories, and auto-approve', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({
    showApproval: true, showWebSearch: true, showNetwork: true, network: false, autoApprove: true,
    additionalDirectories: ['/extra', '/other'],
  }));
  click(visible(document, '.new-chat'));
  click(visible(document, '.open-settings'));
  const approval = document.querySelector('select[data-key="approval"]') as HTMLSelectElement;
  assert.equal(approval.value, 'never');
  assert.equal(approval.querySelector('option')?.title, '');
  approval.value = 'on-request';
  approval.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.approval, 'on-request');
  assert.equal(posted(sent, 'removeDirectory'), undefined);
  const search = document.querySelector('select[data-key="webSearch"]') as HTMLSelectElement;
  search.value = 'live';
  search.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.webSearch, 'live');
  const sandbox = document.querySelector('select[data-key="sandbox"]') as HTMLSelectElement;
  assert.equal(sandbox.querySelector('option')?.title, 'Default');
  sandbox.value = 'read-only';
  sandbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.sandbox, 'read-only');
  const network = document.querySelector('.check input') as HTMLInputElement;
  assert.equal(network.checked, false);
  network.checked = true;
  network.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posted(sent, 'configure')?.network, true);
  assert.equal(posted(sent, 'configure')?.approval, 'never');
  click([...document.querySelectorAll('.dir-row button')].find((button) => button.closest('.dir-row')?.textContent?.includes('/extra'))!);
  assert.equal(posted(sent, 'removeDirectory')?.path, '/extra');
  assert.equal(countType(sent, 'toggleAutoApprove'), 0);
  const auto = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Auto-approve'))!;
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
  click(auto);
  assert.equal(countType(sent, 'toggleAutoApprove'), 1);
  for (const [label, type] of [['Sign in', 'login'], ['API key', 'apiKey'], ['Diagnose', 'diagnose'], ['Usage', 'usage'], ['Rules / Skills / MCP', 'instructions'], ['Logs', 'logs'], ['VS Code settings', 'settings']] as const) {
    click([...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label))!);
    assert.equal(posted(sent, type)?.type, type);
  }
  emit(shell({ showApproval: true, showWebSearch: true, showNetwork: true, busy: true, additionalDirectories: ['/extra'] }));
  assert.equal((document.querySelector('select[data-key="approval"]') as HTMLSelectElement).disabled, true);
  assert.equal((document.querySelector('.check input') as HTMLInputElement).disabled, true);
  assert.equal((document.querySelector('.provider') as HTMLButtonElement).disabled, true);
});

test('usage, banners, changes, terminals, and the queue post their own commands', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, inputIncludesCache: false },
    banner: { id: 'warn', title: 'Careful', body: 'Details' },
    additions: 3, deletions: 1,
    changes: [
      { path: 'src/app.ts', name: 'app.ts', kind: 'update', additions: 3, deletions: 1, canRevert: true, canDiff: true, synthetic: false },
      { path: 'README', name: 'README', kind: 'add', canRevert: false, canDiff: false, synthetic: false },
    ],
    terminals: [{ processId: 'p1', command: 'npm test', status: 'running', output: 'log', error: 'oops' }, { processId: 'p2' }],
  }));
  click(visible(document, '.new-chat'));
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /Input excludes cache/);
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /—/);
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /Not reported/);
  click([...document.querySelectorAll('.banner button')].find((button) => button.textContent?.includes("Don't show"))!);
  assert.equal(posted(sent, 'dismissWarning')?.id, 'warn');
  click(document.querySelector('.banner .icon-btn')!);
  assert.equal(countType(sent, 'dismissWarning'), 2);
  assert.equal(posted(sent, 'send'), undefined);
  assert.match(document.querySelector('.change-head')?.textContent ?? '', /2 Files/);
  assert.match(document.querySelector('.change-head')?.textContent ?? '', /\+3 −1/);
  click([...document.querySelectorAll('.change-head button')].find((button) => button.textContent?.includes('Review'))!);
  assert.equal(posted(sent, 'reviewChanges')?.type, 'reviewChanges');
  const files = [...document.querySelectorAll('.change-file')];
  click(files[0]?.querySelector('.file-link')!);
  assert.equal(posted(sent, 'openDiff')?.path, 'src/app.ts');
  click(files[0]?.querySelector('button.tiny')!);
  assert.equal(posted(sent, 'revertFile')?.path, 'src/app.ts');
  click(files[1]?.querySelector('.file-link')!);
  assert.equal(posted(sent, 'openFile')?.path, 'README');
  assert.equal(posted(sent, 'openDiff')?.path, 'src/app.ts');
  click(visible(document, '.terminal-heading'));
  assert.equal(document.querySelector('.terminal-items')?.hidden, true);
  assert.match(document.querySelector('.terminal-heading .codicon')?.className ?? '', /chevron-right/);
  click(visible(document, '.terminal-heading'));
  assert.match(document.querySelector('.terminal-heading .codicon')?.className ?? '', /chevron-down/);
  assert.match(document.querySelectorAll('.terminal-open')[1]?.textContent ?? '', /p2/);
  assert.equal(document.querySelectorAll('.terminal-state').length, 1);
  emit(shell({ terminals: [{ processId: 'done', command: 'echo', status: 'completed' }], changes: [], additions: 0, deletions: 0 }));
  assert.doesNotMatch(document.querySelector('.change-head')?.textContent ?? '', /\+/);
  const stop = document.querySelector('.terminal-stop') as HTMLButtonElement;
  assert.equal(stop.disabled, true);
  click(stop);
  assert.equal(posted(sent, 'terminateTerminal'), undefined);
  emit(shell({
    busy: true, steer: true, presence: 'running', statusText: 'Running',
    queue: [{ id: 'q1', text: 'later', images: 0 }],
    usage: null,
  }));
  assert.match(document.querySelector('.usage-panel pre')?.textContent ?? '', /No token estimate/);
  click([...document.querySelectorAll('.queue-item button')].find((button) => button.textContent?.includes('Send now'))!);
  assert.equal(posted(sent, 'sendNow')?.id, 'q1');
  click([...document.querySelectorAll('.queue-item button')].find((button) => button.textContent?.includes('Steer'))!);
  assert.equal(posted(sent, 'steer')?.id, 'q1');
  click(document.querySelector('.queue-item .icon-btn')!);
  assert.equal(posted(sent, 'removeQueued')?.id, 'q1');
  emit(shell({ busy: true, steer: false, queue: [{ id: 'q2', text: 'quiet', images: 0 }] }));
  assert.equal([...document.querySelectorAll('.queue-item button')].some((button) => button.textContent?.includes('Steer')), false);
});

test('the composer attaches, suggests, inserts, and refuses empty or cross-talk sends', async () => {
  const { window, sent, emit, input, document, persisted } = boot();
  emit(shell({ conversationId: '' }));
  click(visible(document, '.new-chat'));
  click(visible(document, '.attach'));
  const file = document.querySelector('input[type="file"]') as HTMLInputElement;
  let opened = 0;
  file.click = () => { opened += 1; };
  click(visible(document, '.menu-item[data-id="image"]'));
  assert.equal(opened, 1);
  assert.equal(posted(sent, 'attach'), undefined);
  for (const [id, kind] of [['file', 'file'], ['selection', 'selection'], ['problems', 'problems'], ['git', 'git'], ['terminal', 'terminal']] as const) {
    click(visible(document, '.attach'));
    click(visible(document, `.menu-item[data-id="${id}"]`));
    assert.equal(posted(sent, 'attach')?.kind, kind);
  }
  const png = new window.File(['hi'], 'shot.png', { type: 'image/png' });
  const jpg = new window.File(['hi'], 'shot.jpg', { type: 'image/jpg' });
  const gif = new window.File(['hi'], 'shot.gif', { type: 'image/gif' });
  const webp = new window.File(['hi'], 'shot.webp', { type: 'image/webp' });
  const svg = new window.File(['hi'], 'shot.svg', { type: 'image/svg+xml' });
  const huge = new window.File([new Uint8Array(5_000_001)], 'big.png', { type: 'image/png' });
  const list = new window.DataTransfer();
  for (const item of [png, jpg, gif, webp, svg, huge]) list.items.add(item);
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = window.FileReader;
  file.files = list.files;
  file.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelectorAll('.thumb').length, 4);
  assert.match(document.querySelector('.thumb')?.getAttribute('src') ?? '', /^data:image\/png/);
  const paste = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new window.DataTransfer() });
  input().dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  const imagePaste = new window.DataTransfer();
  imagePaste.items.add(png);
  const pasted = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: imagePaste });
  input().dispatchEvent(pasted);
  assert.equal(pasted.defaultPrevented, true);
  while (document.querySelector('.thumb')) click(document.querySelector('.thumb')!.parentElement!.querySelector('button')!);
  assert.equal(document.querySelector('.thumb'), null);
  assert.equal(posted(sent, 'send'), undefined);
  input().value = 'keep';
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'insert', text: 'body', label: 'file.ts' } }));
  assert.equal(input().value, 'keep\nbody');
  assert.match(document.querySelector('.chip')?.textContent ?? '', /file\.ts/);
  input().value = 'keep\n';
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'insert', text: 'next' } }));
  assert.equal(input().value, 'keep\nnext');
  assert.equal(document.querySelectorAll('.chip').length, 1);
  click(document.querySelector('.chip button')!);
  assert.equal(input().value.includes('body'), false);
  assert.equal(persisted().draft, input().value);
  input().value = '   ';
  click(visible(document, '.send'));
  assert.equal(posted(sent, 'send'), undefined);
  input().value = '';
  key(input(), 'ArrowUp');
  assert.equal(input().value, '');
  input().value = 'hello';
  input().selectionStart = 1;
  input().selectionEnd = 1;
  key(input(), 'ArrowUp');
  assert.equal(input().value, 'hello');
  click(visible(document, '.send'));
  const sentMessage = posted(sent, 'send');
  assert.equal(sentMessage?.prompt, 'hello');
  assert.equal('conversationId' in (sentMessage ?? {}), false);

  input().value = '@readme extra';
  input().selectionStart = 0;
  input().selectionEnd = 0;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = 'plain text';
  input().selectionStart = input().value.length;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = 'hello /run';
  input().selectionStart = input().value.length;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(posted(sent, 'suggest'), undefined);
  input().value = '@rea';
  input().selectionStart = 4;
  input().selectionEnd = 4;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const request = posted(sent, 'suggest');
  assert.equal(request?.kind, 'file');
  assert.equal(request?.query, 'rea');
  input().value = '@readme';
  input().selectionStart = 7;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: request?.requestId, items: [{ label: 'stale', token: 'stale.ts' }] },
  }));
  assert.equal(document.querySelector('.suggest')?.hidden, true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const latest = posted(sent, 'suggest');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: latest?.requestId, items: [{ label: 'My File', token: 'my file.ts', description: 'src' }] },
  }));
  const up = key(input(), 'ArrowUp');
  assert.equal(up.defaultPrevented, true);
  assert.equal(input().getAttribute('aria-activedescendant'), 'suggest-0');
  document.querySelector('.suggest-item')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input().value, '@"my file.ts" ');
  input().value = '\n/te';
  input().selectionStart = 4;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const slash = posted(sent, 'suggest');
  assert.equal(slash?.kind, 'slash');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: slash?.requestId, items: [] },
  }));
  assert.equal(input().hasAttribute('aria-activedescendant'), false);
  input().value = '/test';
  input().selectionStart = 5;
  input().dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const slashChoice = posted(sent, 'suggest');
  assert.equal(slashChoice?.kind, 'slash');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'suggestions', requestId: slashChoice?.requestId, items: [{ label: 'Test', token: 'test' }] },
  }));
  document.querySelector('.suggest-item')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input().value, '/test ');
  globalThis.FileReader = previousReader;
});

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

test('model and build menus ignore mismatched catalogs and post the menu that is open', () => {
  const { window, sent, emit, document } = boot();
  const plan = {
    id: 'plan-1', revision: 2, phase: 'ready' as const, markdown: 'Do it', overview: 'Overview', todos: [],
    source: 'assistant-text' as const, buildModelId: 'gpt-6', buildModelLabel: 'GPT-6', buildParams: [{ id: 'fast', value: 'true' }],
    showBuildModel: true, canBuild: true, history: [],
  };
  emit(shell({ planView: plan }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
  click(visible(document, '.new-chat'));
  click(visible(document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  const deliver = (extra: Record<string, unknown>) => window.dispatchEvent(new window.MessageEvent('message', {
    data: { ...catalog, requestId: request?.requestId, ...extra },
  }));
  deliver({ requestId: 999 });
  deliver({ provider: 'cursor' });
  deliver({ cwd: '/elsewhere' });
  assert.match(document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);
  deliver({ status: 'error', error: 'offline', models: [] });
  assert.match(document.querySelector('.model-menu')?.textContent ?? '', /offline/);
  click(visible(document, '.menu-item[data-id="refresh"]'));
  assert.equal(posted(sent, 'loadModelCatalog')?.refresh, true);
  assert.equal(document.querySelector('.model-menu')?.hidden, false);
  const again = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', { data: { ...catalog, requestId: again?.requestId, selectedModelId: 'sol' } }));
  assert.equal(document.querySelector('.menu-item[data-id="broken"]'), null);
  assert.equal(document.querySelector('.menu-item[data-id="fast"]')?.getAttribute('aria-checked'), 'false');
  click(visible(document, '.menu-item[data-id="model"]'));
  assert.equal(visible(document, '.menu-item[data-id="model:gpt-6"]').getAttribute('aria-checked'), 'true');
  click(visible(document, '.menu-item[data-id="refresh"]'));
  assert.equal(posted(sent, 'loadModelCatalog')?.refresh, true);
  const refreshed = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', { data: { ...catalog, requestId: refreshed?.requestId } }));
  click(visible(document, '.menu-item[data-id="fast"]'));
  assert.equal(posted(sent, 'setModelParam')?.id, 'fast');
  assert.equal(posted(sent, 'setModelParam')?.value, 'true');
  assert.equal(posted(sent, 'setBuildParam'), undefined);
  click(visible(document, '.model-name'));
  const third = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', { data: { ...catalog, requestId: third?.requestId } }));
  click(visible(document, '.menu-item[data-id="modelReasoningEffort"]'));
  assert.match(visible(document, '.menu-item[data-id="modelReasoningEffort:low"]').title, /Quick/);
  click(visible(document, '.plan-actions .pill'));
  const buildRequest = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { ...catalog, requestId: buildRequest?.requestId, selectedModelId: 'gpt-6', selectedParams: [] },
  }));
  assert.equal(document.querySelector('.menu-item[data-id="fast"]')?.getAttribute('aria-checked'), 'true');
  click(visible(document, '.menu-item[data-id="fast"]'));
  assert.equal(posted(sent, 'setBuildParam')?.value, 'false');
  click(visible(document, '.plan-actions .pill'));
  const buildAgain = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', { data: { ...catalog, requestId: buildAgain?.requestId, selectedModelId: 'gpt-6' } }));
  click(visible(document, '.menu-item[data-id="model"]'));
  click(visible(document, '.menu-item[data-id="model:gpt-6"]'));
  assert.equal(posted(sent, 'setBuildModel')?.modelId, 'gpt-6');
  assert.equal(posted(sent, 'setModel'), undefined);
  emit(shell({ planView: { ...plan, canBuild: true }, modelSettings: 'unsupported' }));
  const before = countType(sent, 'loadModelCatalog');
  click(document.querySelector('.plan-actions .pill')!);
  assert.equal(countType(sent, 'loadModelCatalog'), before);
  assert.equal(document.querySelector('.model-menu')?.hidden, true);
});

test('plans render every phase, and a disabled build does not post', () => {
  const { sent, emit, document } = boot();
  const plan = (phase: ViewShell['planView'] extends infer T ? T extends { phase: infer P } ? P : never : never, extra: Record<string, unknown> = {}) => ({
    id: 'plan-1', revision: 4, phase, markdown: 'Body', todos: [], source: 'assistant-text' as const,
    buildModelId: 'gpt', buildModelLabel: 'GPT', buildParams: [], showBuildModel: false, canBuild: false, history: [], ...extra,
  });
  emit(shell());
  click(visible(document, '.new-chat'));
  assert.equal(document.querySelector('.plan-slot')?.hidden, true);
  for (const [phase, label] of [['planning', 'Updating plan'], ['revising', 'Updating plan'], ['building', 'Building'], ['implemented', 'Build finished'], ['ready', 'Ready to build'], ['idle', 'assistant-text']] as const) {
    emit(shell({ planView: plan(phase) }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
    assert.match(document.querySelector('.plan-phase')?.textContent ?? '', new RegExp(label));
  }
  const first = document.querySelector('.plan-view');
  emit(shell({ planView: plan('ready', {
    restored: true, error: 'Could not revise', overview: 'Overview', showBuildModel: true, canBuild: false,
    todos: [
      { content: 'done', status: 'completed' },
      { content: 'finished', status: 'done' },
      { content: 'working', status: 'in_progress' },
      { content: 'started', status: 'inProgress' },
      { content: 'later', status: 'pending' },
    ],
    files: ['src/app.ts', 'README.md'],
    history: [{ revision: 1, markdown: 'Old' }, { revision: 3, name: 'Named', markdown: 'Named body' }],
  }) }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
  assert.notEqual(document.querySelector('.plan-view'), first);
  assert.match(document.querySelector('.note')?.textContent ?? '', /Saved plan/);
  assert.match(document.querySelector('.plan-error')?.textContent ?? '', /Could not revise/);
  assert.match(document.querySelector('.plan-body')?.textContent ?? '', /Overview/);
  assert.match(document.querySelector('.todo-progress')?.textContent ?? '', /2 \/ 5/);
  assert.equal(document.querySelectorAll('.plan-todos .done').length, 2);
  assert.equal(document.querySelectorAll('.plan-todos .active').length, 2);
  assert.deepEqual([...document.querySelectorAll('.plan-files li')].map((node) => node.textContent), ['src/app.ts', 'README.md']);
  assert.match(document.querySelector('.plan-history')?.textContent ?? '', /Plan 1/);
  assert.match(document.querySelector('.plan-history')?.textContent ?? '', /Named/);
  const build = document.querySelector('.build') as HTMLButtonElement;
  const model = document.querySelector('.plan-actions .pill') as HTMLButtonElement;
  assert.equal(build.disabled, true);
  assert.equal(model.disabled, true);
  click(build);
  assert.equal(posted(sent, 'buildPlan'), undefined);
  const stable = document.querySelector('.plan-view');
  emit(shell({ planView: plan('ready', {
    restored: true, error: 'Could not revise', overview: 'Overview', showBuildModel: true, canBuild: false,
    todos: [
      { content: 'done', status: 'completed' }, { content: 'finished', status: 'done' },
      { content: 'working', status: 'in_progress' }, { content: 'started', status: 'inProgress' }, { content: 'later', status: 'pending' },
    ],
    files: ['src/app.ts', 'README.md'],
    history: [{ revision: 1, markdown: 'Old' }, { revision: 3, name: 'Named', markdown: 'Named body' }],
  }) }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
  assert.equal(document.querySelector('.plan-view'), stable);
  emit(shell({ mode: 'plan', planView: plan('ready', { canBuild: true, showBuildModel: true }) }));
  assert.equal(document.querySelector('#prompt')?.getAttribute('placeholder'), 'Revise the plan…');
  emit(shell({ showMode: false, planView: null }));
  assert.equal(document.querySelector('.mode')?.hidden, true);
  assert.equal(document.querySelector('.plan-slot')?.hidden, true);
});

test('mode, environment, and pending cards post only the selected command', () => {
  const { window, sent, emit, document } = boot();
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }));
  click(visible(document, '.new-chat'));
  click(document.querySelector('.mode')!);
  assert.equal(document.querySelector('.menu')?.hidden, true);
  emit(shell());
  click(visible(document, '.mode'));
  assert.match(visible(document, '.menu-item[data-id="ask"]').textContent ?? '', /Questions/);
  click(visible(document, '.menu-item[data-id="ask"]'));
  assert.equal(posted(sent, 'configure')?.mode, 'ask');
  click(visible(document, '.env'));
  click(visible(document, '.menu-item[data-id="/other"]'));
  assert.equal(posted(sent, 'select')?.cwd, '/other');
  click(visible(document, '.env'));
  click(visible(document, '.menu-item[data-id="settings"]'));
  assert.equal(document.querySelector('.settings-panel')?.hidden, false);
  emit(shell({
    permission: null,
    plan: { token: 'p', request: { id: 'plan', name: 'Ship', overview: 'Over', plan: '**Body**', todos: [] } },
  }));
  assert.match(document.querySelector('.pending .md')?.textContent ?? '', /Over/);
  assert.equal(document.querySelector('.pending .md strong')?.textContent, 'Body');
  click([...document.querySelectorAll('.pending button')].find((button) => button.textContent === 'Reject')!);
  assert.equal(posted(sent, 'resolvePlan')?.decision, 'rejected');
  assert.equal(posted(sent, 'resolveQuestion'), undefined);
  emit(shell({
    question: { token: 'q', request: { id: 'ask', title: '', questions: [{ id: 'free', prompt: 'Name', options: [] }] } },
  }));
  const text = document.querySelector('.pending input') as HTMLInputElement;
  text.value = 'Ada';
  click(document.querySelector('.pending button')!);
  assert.deepEqual(posted(sent, 'resolveQuestion')?.answers, { free: ['Ada'] });
  emit(shell({
    permission: { token: 'once', request: { id: 'perm', title: 'Run', detail: 'npm test', kind: 'shell' } },
  }));
  const allow = [...document.querySelectorAll('.pending button')].find((button) => button.textContent === 'Allow');
  const again = emit;
  again(shell({ permission: { token: 'once', request: { id: 'perm', title: 'Run', detail: 'npm test', kind: 'shell' } } }));
  assert.equal(document.querySelector('.pending button'), allow);
  emit(shell());
  assert.equal(document.querySelector('.pending')?.hidden, true);
  assert.equal(document.querySelector('.pending-card'), null);
});

test('diffs, icons, and streaming answers keep fold state across renders', () => {
  const { window, sent, emit, document } = boot();
  const preview = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'context' as const, line: index + 1, text: `line ${index}` }));
  const files = (count: number, additions = 1) => [{
    id: 'user', role: 'user' as const, text: 'edit', at: 1,
  }, {
    id: 'files', role: 'tool' as const, text: 'changed', at: 2, turnId: 'user',
    meta: { type: 'files' as const, files: [{ path: 'src/app.ts', kind: 'update', additions, deletions: 0, preview: preview(count) }] },
  }];
  emit(shell(), files(6));
  click(visible(document, '.new-chat'));
  assert.equal(document.querySelector('.diff-preview-toggle'), null);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 6);
  emit(shell(), files(7));
  assert.equal(document.querySelector('.diff-preview-toggle'), null);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 7);
  emit(shell(), files(8));
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 6);
  click(document.querySelector('.diff-preview-toggle')!);
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), true);
  emit(shell(), files(8, 2));
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), true);
  assert.equal(document.querySelectorAll('.diff-preview-line').length, 8);
  click(document.querySelector('.diff-preview-toggle')!);
  emit(shell(), files(8, 3));
  assert.equal(document.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), false);
  const mixed = [
    { kind: 'context' as const, line: 1, text: 'a' },
    { kind: 'remove' as const, line: 2, text: 'b' },
    { kind: 'add' as const, line: 2, text: 'c' },
    { kind: 'context' as const, line: 3, text: 'd' },
    { kind: 'context' as const, line: 4, text: 'e' },
    { kind: 'context' as const, line: 5, text: 'f' },
    { kind: 'more' as const, text: 'omitted' },
    { kind: 'eof' as const, text: 'end' },
  ];
  emit(shell(), [{ id: 'user', role: 'user', text: 'edit', at: 1 }, { id: 'files', role: 'tool', text: 'changed', at: 2, turnId: 'user', meta: { type: 'files', files: [
    { path: 'Makefile', kind: 'update', preview: mixed, icon: { type: 'badge', badge: 'MK' } },
    { path: 'shot.png', kind: 'update', additions: 1, preview: [{ kind: 'add', line: 1, text: 'x' }], icon: { type: 'image', src: 'https://example.test/png.svg' } },
    { path: 'app.ts', kind: 'update', deletions: 2, preview: [{ kind: 'remove', text: 'old' }], icon: { type: 'font', fontCharacter: '\\E111', fontFamily: 'seti', fontColor: '#abc' } },
    { path: 'dir/', kind: 'update', preview: [{ kind: 'context', text: 'name' }] },
  ] } }]);
  assert.equal(document.querySelector('.file-badge')?.textContent, 'MK');
  assert.equal(document.querySelector('.file-badge')?.dataset.lang, 'file');
  assert.equal(document.querySelector('.diff-preview-line.more')?.textContent, 'omitted');
  assert.equal(document.querySelector('img.file-icon')?.getAttribute('src'), 'https://example.test/png.svg');
  assert.equal(document.querySelector('.font-icon')?.textContent, '\uE111');
  assert.equal(document.querySelectorAll('.file-link')[3]?.textContent, 'dir/');
  click(document.querySelector('.diff-preview-toggle')!);
  assert.equal(document.querySelector('.diff-preview-line.eof')?.textContent, 'end');
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'x'.repeat(20)} **z**`, at: 2, turnId: 'user' },
  ]);
  assert.equal(document.querySelector('.answer .md strong')?.textContent, 'z');
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: 'y'.repeat(4000), at: 2, turnId: 'user' },
  ]);
  const streaming = document.querySelector('.answer .md') as HTMLElement;
  assert.equal(streaming.classList.contains('is-streaming'), true);
  assert.equal(streaming.textContent?.length, 4000);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'y'.repeat(4000)}Z`, at: 2, turnId: 'user' },
  ]);
  assert.equal(streaming.textContent?.endsWith('Z'), true);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: 'n'.repeat(4000), at: 2, turnId: 'user' },
  ]);
  assert.equal(streaming.textContent, 'n'.repeat(4000));
  emit(shell(), [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text: `${'n'.repeat(4000)}\n\n**done**`, at: 2, turnId: 'user', final: true },
  ]);
  assert.equal(document.querySelector('.answer .md strong')?.textContent, 'done');
  void window;
  void sent;
});

test('tool rows, subagents, and edits post the matching command or nothing', () => {
  const { window, sent, emit, document, input } = boot();
  const detail = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
  emit(shell({ locale: 'ja' }), [
    { id: 'user', role: 'user', text: 'go', attachments: ['a.ts'], at: 1, canRewind: true },
    { id: 'user-2', role: 'user', text: 'second', at: 8, canRewind: true },
    { id: 'think', role: 'status', text: 'hmm', at: Date.now() - 5000, turnId: 'user', meta: { type: 'thinking' } },
    { id: 'read', role: 'tool', text: 'read', at: 2, turnId: 'user', tool: { name: 'Read', kind: 'read', status: 'completed', target: 'src/app.ts', line: 2, endLine: 2 } },
    { id: 'range', role: 'tool', text: 'range', at: 3, turnId: 'user', tool: { name: 'Read', kind: 'read', status: 'running', target: 'src/app.ts', line: 2, endLine: 5 } },
    { id: 'edit', role: 'tool', text: 'edit', turnId: 'user', tool: { name: 'Edit', kind: 'edit', status: 'error', target: 'other.ts' } },
    { id: 'search', role: 'tool', text: detail, turnId: 'user', tool: { name: 'Search', kind: 'search', status: 'completed', target: 'query' } },
    { id: 'git', role: 'tool', text: 'git', turnId: 'user', tool: { name: 'Git', kind: 'git', status: 'completed' } },
    { id: 'mcp', role: 'tool', text: 'mcp', turnId: 'user', tool: { name: 'MCP', kind: 'mcp', status: 'completed' } },
    { id: 'task', role: 'tool', text: 'task', turnId: 'user', tool: { name: 'Task', kind: 'subagent', status: 'completed' } },
    { id: 'other', role: 'tool', text: 'other', turnId: 'user', tool: { name: 'Widget', kind: 'other', status: 'completed' } },
    { id: 'shell-run', role: 'tool', text: 'in-progress: npm test\npartial', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'running', target: 'sudo npm test' } },
    { id: 'shell-env', role: 'tool', text: 'hello\nworld', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'completed', target: 'FOO=bar echo hi' } },
    { id: 'shell-bad', role: 'tool', text: 'completed: echo', turnId: 'user', tool: { name: 'command', kind: 'shell', status: 'error', target: '|' } },
    { id: 'sub-a', role: 'status', text: 'a', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's1', name: 'one', status: 'unknown', background: 'unknown', model: 'gpt', durationMs: 1500, task: 'look', resultPreview: 'found' } } },
    { id: 'sub-b', role: 'status', text: 'b', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's2', name: 'two', status: 'completed', background: true } } },
    { id: 'sub-c', role: 'status', text: 'c', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's3', name: 'three', status: 'error', background: 'unknown' } } },
    { id: 'sub-d', role: 'status', text: 'd', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's4', name: 'four', status: 'cancelled', background: 'unknown' } } },
    { id: 'sub-e', role: 'status', text: 'e', turnId: 'user', meta: { type: 'subagent', subagent: { id: 's5', name: 'five', status: 'running', background: 'unknown' } } },
    { id: 'todos', role: 'status', text: 'todos', turnId: 'user', meta: { type: 'todo', todos: [{ content: 'ship', status: 'done' }, { content: 'wait', status: 'pending' }] } },
    { id: 'answer', role: 'assistant', text: 'ok', at: 9, turnId: 'user', final: true },
  ]);
  click(visible(document, '.new-chat'));
  const read = document.querySelector('[data-action="open-file"][data-path="src/app.ts"]') as HTMLButtonElement;
  assert.equal(read.title, 'Open src/app.ts:2');
  click(read);
  assert.equal(posted(sent, 'openFile')?.line, 2);
  assert.equal(posted(sent, 'openFile')?.endLine, 2);
  const ranged = [...document.querySelectorAll('[data-action="open-file"]')].find((node) => node.getAttribute('data-end-line') === '5');
  assert.match(ranged?.textContent ?? '', /L2-5/);
  click([...document.querySelectorAll('[data-action="toggle-tool"]')].find((node) => node.textContent?.includes('Search'))!);
  click(document.querySelector('[data-action="more"]')!);
  assert.match(document.querySelector('.tool-row-item pre')?.textContent ?? '', /line 40/);
  assert.match(document.body.textContent ?? '', /Run npm/);
  assert.match(document.body.textContent ?? '', /Run echo/);
  assert.match(document.body.textContent ?? '', /Run command/);
  assert.match(document.querySelector('.subagents')?.textContent ?? '', /バックグラウンド/);
  assert.match(document.querySelector('.subagents')?.textContent ?? '', /gpt/);
  assert.match(document.querySelector('.thinking summary')?.textContent ?? '', /思考/);
  click(document.querySelector('.copy-answer')!);
  const copied = posted(sent, 'copy');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: copied?.requestId, ok: false } }));
  assert.match(document.querySelector('.copy-answer')?.getAttribute('title') ?? '', /失敗/);
  click([...document.querySelectorAll('.edit-user')].at(-1)!);
  const editor = document.querySelector('.edit-prompt') as HTMLTextAreaElement;
  editor.value = 'rewritten';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(document.querySelector('[data-action="rewind"]')!);
  assert.equal(posted(sent, 'rewind')?.turnId, 'user-2');
  assert.equal(posted(sent, 'rewind')?.editedText, 'rewritten');
  assert.equal(posted(sent, 'send'), undefined);
  emit(shell({ busy: true, presence: 'running', statusText: 'Running' }), [
    { id: 'user', role: 'user', text: 'go', at: 1, canRewind: true },
    { id: 'failed', role: 'error', text: 'nope', at: 2 },
  ]);
  click(document.querySelector('[data-action="retry"]')!);
  assert.equal(posted(sent, 'prepareRetry'), undefined);
  assert.equal(posted(sent, 'send'), undefined);
  const root = document.querySelector('.thread')!;
  const stray = document.createElement('button');
  stray.dataset.action = 'copy-answer';
  root.append(stray);
  const copies = countType(sent, 'copy');
  click(stray);
  assert.equal(countType(sent, 'copy'), copies);
  const diff = document.createElement('button');
  diff.dataset.action = 'open-diff';
  diff.dataset.path = 'src/app.ts';
  diff.dataset.line = '3';
  diff.dataset.endLine = '8';
  diff.dataset.column = '2';
  root.append(diff);
  click(diff);
  assert.deepEqual(posted(sent, 'openDiff'), {
    provider: 'codex', cwd: '/workspace', conversationId: 'front', type: 'openDiff', path: 'src/app.ts', line: 3, endLine: 8, column: 2,
  });
  const zero = document.createElement('button');
  zero.dataset.action = 'open-file';
  zero.dataset.path = 'zero.ts';
  zero.dataset.line = '0';
  root.append(zero);
  click(zero);
  assert.equal(posted(sent, 'openFile')?.path, 'zero.ts');
  assert.equal('line' in (posted(sent, 'openFile') ?? {}), false);
  emit(shell(), []);
  assert.match(document.querySelector('.empty')?.textContent ?? '', /AI Agents/);
  assert.equal(input().value, '');
  void window;
});

test('a direct transcript covers streaming boundaries and commands that must not post', () => {
  const window = new Window();
  const root = window.document.createElement('main');
  window.document.body.append(root);
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const transcript = new Transcript(createDom(window.document), root, (message) => sent.push(message), () => {}, () => {}, () => {});
  const busy = shell({ busy: true, presence: 'running', statusText: 'Running' });
  const messages = (text: string, final = false): ViewMessage[] => [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text, at: 2, turnId: 'user', ...(final ? { final: true } : {}) },
  ];
  transcript.render(messages(`${'a'.repeat(20)} **z**`), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md strong')?.textContent, 'z');
  transcript.render(messages('b'.repeat(4000)), busy, strings('en'));
  const node = root.querySelector('.answer .md')?.firstChild;
  transcript.render(messages('b'.repeat(4000)), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.firstChild, node);
  transcript.render(messages(`${'b'.repeat(4000)}Z`), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.textContent?.endsWith('Z'), true);
  transcript.render(messages('c'.repeat(4000)), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.textContent, 'c'.repeat(4000));
  transcript.render(messages(`${'c'.repeat(20)}\n\n**done**`, true), shell(), strings('en'));
  assert.equal(root.querySelector('strong')?.textContent, 'done');
  const button = window.document.createElement('button');
  button.dataset.action = 'noop';
  root.append(button);
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.length, 0);
  root.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.length, 0);
});

test('rendering settings does not post a configure event', () => {
  const { window, sent, emit } = boot();
  const proto = window.HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!descriptor?.set || !descriptor.get) return;
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get: descriptor.get,
    set(value: string) {
      descriptor.set?.call(this, value);
      this.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
  });
  try {
    emit(shell({ showApproval: true, showNetwork: true }));
    assert.equal(posted(sent, 'configure'), undefined);
    const approval = window.document.querySelector('select[data-key="approval"]') as HTMLSelectElement;
    approval.value = 'on-request';
    assert.equal(posted(sent, 'configure')?.approval, 'on-request');
  } finally {
    Object.defineProperty(proto, 'value', descriptor);
  }
});

test('retry preparation ignores a different provider or directory', () => {
  const { window, sent, emit, document } = boot();
  emit(shell(), [
    { id: 'image-turn', role: 'user', text: 'picture', attachments: ['image.png'], at: 1 },
    { id: 'failed', role: 'error', text: 'Disconnected', at: 2 },
  ]);
  click(visible(document, '.new-chat'));
  click(document.querySelector('[data-action="retry"]')!);
  for (const extra of [{ provider: 'cursor' }, { cwd: '/elsewhere' }, { conversationId: 'other' }]) {
    window.dispatchEvent(new window.MessageEvent('message', { data: {
      type: 'retryPrepared', id: 'image-turn', text: 'picture', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=', name: 'image.png' }],
      provider: 'codex', cwd: '/workspace', conversationId: 'front', ...extra,
    } }));
    assert.equal(document.querySelector('.thumb'), null, JSON.stringify(extra));
  }
  assert.equal(posted(sent, 'send'), undefined);
});
