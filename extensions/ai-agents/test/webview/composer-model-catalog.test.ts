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
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }, { name: 'other', path: '/other' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'front',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
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
