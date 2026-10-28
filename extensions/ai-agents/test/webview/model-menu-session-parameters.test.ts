import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewShell } from '../../src/protocol.js';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'Chat', modelLabel: 'Model', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [], modes: [{ id: 'agent', label: 'Agent' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [{ id: 'never', label: 'Never' }], approval: 'never', showApproval: false,
    webSearchChoices: [{ id: '', label: 'Off' }], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false,
    steer: false, interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0,
    sessions: [], usage: null, permission: null, plan: null, question: null, conversationId: 'conversation',
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
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
