import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { createDom } from '../../src/webview/dom.js';

import { SettingsPanel } from '../../src/webview/settings.js';

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

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

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
