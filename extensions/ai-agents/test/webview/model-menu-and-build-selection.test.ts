import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backend: 'cli',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function mount() {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  let persisted: unknown;
  const vscode: VsCodeApi = { postMessage(message) { sent.push(message); }, getState: () => null, setState(state) { persisted = state; } };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  return { window, sent, app, emit, persisted: () => persisted as { draft?: string }, input: () => window.document.querySelector('textarea') as HTMLTextAreaElement };
}

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('the model menu searches, checks the selection, and keeps the draft', () => {
  const { window, sent, input, emit } = mount();
  emit(shell({ modelLabel: 'A very long model name that must stay on one line' }));
  input().value = 'keep this sentence';
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  assert.equal(typeof request?.requestId, 'number');
  const deliver = (requestId: number) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: {
        type: 'modelCatalog', requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
        selectedModelId: 'gpt-6', selectedParams: [{ id: 'modelReasoningEffort', value: 'xhigh' }],
        models: [
          {
            id: 'gpt-6', label: 'GPT-6.1 Sol', aliases: ['sol'], description: 'Balanced',
            parameters: [{
              id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu',
              values: [
                { value: 'low', label: 'Low' },
                { value: 'xhigh', label: 'Extra High' },
              ],
            }],
          },
          { id: 'other', label: 'Other Model', parameters: [] },
        ],
      },
    }));
  };
  deliver(99);
  assert.match(window.document.querySelector('.model-menu')?.textContent ?? '', /Loading models/);
  deliver(Number(request?.requestId));
  const effort = visible(window.document, '.menu-item[data-id="modelReasoningEffort"]');
  assert.match(effort.textContent ?? '', /Extra High/);
  click(effort);
  const extra = visible(window.document, '.menu-item[data-id="modelReasoningEffort:xhigh"]');
  assert.equal(extra.getAttribute('aria-checked'), 'true');
  extra.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(window.document.querySelector('.menu-item[data-id="modelReasoningEffort:xhigh"]'), null);
  assert.equal(window.document.querySelector('.model-menu')?.hidden, false);
  window.document.querySelector('.model-menu')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(window.document.querySelector('.model-menu')?.hidden, true);
  assert.equal(input().value, 'keep this sentence');

  click(visible(window.document, '.model-name'));
  const again = posted(sent, 'loadModelCatalog');
  deliver(Number(again?.requestId));
  click(visible(window.document, '.menu-item[data-id="model"]'));
  const search = window.document.querySelector('.menu-search') as HTMLInputElement;
  assert.equal(search.placeholder, 'Search models');
  assert.equal(window.document.querySelector('[data-id="model:default"]'), null);
  assert.doesNotMatch(search.closest('.model-menu')?.textContent ?? '', /Default model/);
  assert.equal(visible(window.document, '.menu-item[data-id="model:gpt-6"]').getAttribute('aria-checked'), 'true');
  assert.match(visible(window.document, '.menu-item[data-id="model:gpt-6"]').title, /A very long model name|GPT-6.1 Sol/);
  search.value = 'missing-model';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(search.closest('.model-menu')?.textContent ?? '', /No matching models/);
  search.value = 'SOL';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(window.document.querySelector('.menu-item[data-id="model:gpt-6"]'));
  window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(window.document.querySelector('.model-menu')?.hidden, true);
  assert.equal(input().value, 'keep this sentence');

  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /\.vscode-high-contrast \.menu/);
  assert.match(css, /--vscode-editorWidget-background/);
  assert.match(window.document.querySelector('.model-name')?.textContent ?? '', /A very long model name/);
  assert.match(window.document.querySelector('.model-name')?.getAttribute('title') ?? '', /A very long model name that must stay on one line/);
});

test('a narrow model menu drills in instead of opening beside the root', () => {
  const { window, sent, emit } = mount();
  window.innerWidth = 300;
  window.innerHeight = 640;
  emit(shell());
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'modelCatalog', requestId: request?.requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
      selectedModelId: 'gpt', selectedParams: [{ id: 'fast', value: 'false' }],
      models: [{ id: 'gpt', label: 'GPT', parameters: [{ id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] }] }],
    },
  }));
  assert.equal(window.document.querySelector('.menu-item[data-id="fast"]')?.getAttribute('aria-checked'), 'false');
  click(visible(window.document, '.menu-item[data-id="model"]'));
  assert.ok(window.document.querySelector('.menu-item[data-id="back"]'));
  assert.equal(window.document.querySelector('.model-menu.submenu')?.hidden, true);
  window.document.querySelector('.model-menu')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  click(visible(window.document, '.menu-item[data-id="model:gpt"]'));
  assert.equal(posted(sent, 'setModel')?.modelId, 'gpt');
});

test('a model catalog cannot cross a backend or session change', () => {
  const { window, sent, emit } = mount();
  emit(shell({ backend: 'cli', sessionId: 'a' }));
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog')!;
  const deliver = (requestId: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data: {
    type: 'modelCatalog', requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
    selectedModelId: 'stale', selectedParams: [], models: [{ id: 'stale', label: 'Stale model', parameters: [] }],
  } }));
  deliver(request.requestId);
  assert.match(window.document.querySelector('.model-menu')!.textContent!, /Stale model/);
  emit(shell({ backend: 'app-server', sessionId: 'b' }));
  deliver(request.requestId);
  click(visible(window.document, '.model-name'));
  assert.match(window.document.querySelector('.model-menu')!.textContent!, /Loading models/);
  assert.doesNotMatch(window.document.querySelector('.model-menu')!.textContent!, /Stale model/);
});

test('an open mode menu closes when its conversation changes or starts running', () => {
  const { window, emit } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.mode'));
  assert.equal(window.document.querySelector('.menu')?.hidden, false);
  emit(shell({ conversationId: 'other', modes: [{ id: 'agent', label: 'Agent' }] }));
  assert.equal(window.document.querySelector('.menu')?.hidden, true);
  click(visible(window.document, '.mode'));
  emit(shell({ conversationId: 'other', busy: true }));
  assert.equal(window.document.querySelector('.menu')?.hidden, true);
});

test('Build posts the visible plan and a plan error stays on the card', () => {
  const { window, sent, emit } = mount();
  emit(shell({
    planView: {
      id: 'plan-1', revision: 3, phase: 'ready', markdown: 'Do the thing', todos: [], source: 'assistant-text',
      buildModelId: 'composer-2.5', buildModelLabel: 'Composer 2.5', buildParams: [{ id: 'fast', value: 'true' }],
      showBuildModel: true, canBuild: true, history: [], error: 'Could not revise',
    },
  }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
  click(visible(window.document, '.new-chat'));
  assert.match(window.document.querySelector('.plan-error')?.textContent ?? '', /Could not revise/);
  click(visible(window.document, '.build'));
  assert.equal(posted(sent, 'buildPlan')?.planId, 'plan-1');
  assert.equal(posted(sent, 'buildPlan')?.revision, 3);
  assert.equal(posted(sent, 'buildPlan')?.modelId, 'composer-2.5');
  assert.equal((window.document.querySelector('.build') as HTMLButtonElement).disabled, true);
});

test('choosing another effort posts that value and Escape does not', () => {
  const { window, sent, emit } = mount();
  emit(shell());
  click(visible(window.document, '.new-chat'));
  click(visible(window.document, '.model-name'));
  const request = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'modelCatalog', requestId: Number(request?.requestId), provider: 'codex', cwd: '/workspace', status: 'ready',
      selectedModelId: 'gpt-6', selectedParams: [{ id: 'modelReasoningEffort', value: 'xhigh' }],
      models: [{
        id: 'gpt-6', label: 'GPT-6',
        parameters: [{
          id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu',
          values: [{ value: 'low', label: 'Low' }, { value: 'xhigh', label: 'Extra High' }],
        }],
      }],
    },
  }));
  click(visible(window.document, '.menu-item[data-id="modelReasoningEffort"]'));
  click(visible(window.document, '.menu-item[data-id="modelReasoningEffort:low"]'));
  assert.equal(posted(sent, 'setModelParam')?.id, 'modelReasoningEffort');
  assert.equal(posted(sent, 'setModelParam')?.value, 'low');
  click(visible(window.document, '.model-name'));
  const again = posted(sent, 'loadModelCatalog');
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'modelCatalog', requestId: Number(again?.requestId), provider: 'codex', cwd: '/workspace', status: 'ready',
      selectedModelId: 'gpt-6', selectedParams: [{ id: 'modelReasoningEffort', value: 'xhigh' }],
      models: [{
        id: 'gpt-6', label: 'GPT-6',
        parameters: [{
          id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu',
          values: [{ value: 'low', label: 'Low' }, { value: 'xhigh', label: 'Extra High' }],
        }],
      }],
    },
  }));
  click(visible(window.document, '.menu-item[data-id="modelReasoningEffort"]'));
  window.document.querySelector('.model-menu')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(sent.filter((message) => message && typeof message === 'object' && 'type' in message && message.type === 'setModelParam').length, 1);
});
