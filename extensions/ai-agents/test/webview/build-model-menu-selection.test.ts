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
