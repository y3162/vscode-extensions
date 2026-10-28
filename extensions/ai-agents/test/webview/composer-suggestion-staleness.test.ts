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
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'Default model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'thread-1',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function planView(extra: Partial<ViewPlan> = {}): ViewPlan {
  return {
    id: 'plan-1', revision: 2, phase: 'ready', name: 'Plan', markdown: 'Plan body', todos: [], source: 'generated',
    buildModelId: 'build-alias', buildModelLabel: '', buildParams: [], showBuildModel: true, canBuild: true, history: [], ...extra,
  };
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
