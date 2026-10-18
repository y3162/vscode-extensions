import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu } from '../../src/webview/popover.js';

import { strings } from '../../src/webview/strings.js';

function shell(planView: ViewPlan | null = null): ViewShell {
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
    planView, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }],
  };
}

function plan(): ViewPlan {
  return {
    id: 'plan', revision: 1, phase: 'ready', markdown: 'Build plan', todos: [], source: 'generated',
    buildModelId: 'model-a', buildModelLabel: 'Model A', buildParams: [{ id: 'effort', value: 'low' }],
    showBuildModel: true, canBuild: true, history: [],
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('build-model parameter submenu posts the build-specific update after the user selects a value', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  composer.render(shell(plan()), strings('en'));
  const anchor = host.querySelector<HTMLElement>('.model-name')!;
  composer.openBuildModel(anchor);
  const requestId = (sent.at(-1) as { requestId: number }).requestId;
  composer.setCatalog({
    type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId, status: 'ready',
    selectedModelId: 'model-a', selectedParams: [{ id: 'effort', value: 'low' }],
    models: [{ id: 'model-a', label: 'Model A', parameters: [{
      id: 'effort', label: 'Effort', role: 'effort', presentation: 'menu',
      values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    }] }],
  });
  click(host.querySelector('.model-menu [data-id="effort"]') as HTMLElement);
  click(host.querySelector('.model-menu [data-id="effort:high"]') as HTMLElement);
  const update = [...sent].reverse().find((item) => (item as { type?: string }).type === 'setBuildParam') as Record<string, unknown> | undefined;
  assert.deepEqual({ type: update?.type, id: update?.id, value: update?.value }, { type: 'setBuildParam', id: 'effort', value: 'high' });
  window.happyDOM.abort();
});
