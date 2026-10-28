import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask', description: 'Questions' }],
    mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write', description: 'Default' }, { id: 'read-only', label: 'Read only' }],
    sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }],
    approval: 'never', showApproval: false, webSearchChoices: [{ id: '', label: 'Off' }, { id: 'live', label: 'Live' }],
    webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
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
  click(visible(document, '.plan-view-toggle'));
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
