import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { createDom } from '../../src/webview/dom.js';
import { renderPlanView } from '../../src/webview/plan-view.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

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

function bootTranscript() {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const sent: unknown[] = [];
  const rewinds: { id: string; text: string }[] = [];
  const transcript = new Transcript(dom, root, (message) => sent.push(message), () => {}, () => {}, (id, text) => rewinds.push({ id, text }));
  return { window, dom, root, sent, rewinds, transcript };
}

test('plan view uses its localized model label when the selected build label is empty', () => {
  const { window, root, transcript } = bootTranscript();
  transcript.render([], shell({ planView: planView({ buildModelLabel: '' }) }), strings('en'), true);
  assert.equal(root.querySelector('.plan-actions .pill .btn-label')?.textContent, strings('en').model);
  (root.querySelector('.plan-view-toggle') as HTMLButtonElement).click();
  window.happyDOM.abort();
});

test('plan summary truncates long text and identifies both Cursor plan sources', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const render = (view: ViewPlan, expanded: boolean) =>
    renderPlanView(host, shell({ planView: view }), dom, strings('en'), () => {}, () => {}, expanded, () => {});
  render(planView({ overview: 'word '.repeat(60) }), false);
  const summary = host.querySelector('.plan-summary')?.textContent ?? '';
  assert.equal(summary.length, 238);
  assert.ok(summary.endsWith('…'));
  render(planView({ source: 'acp-create-plan' }), true);
  assert.match(host.querySelector('.plan-source')?.textContent ?? '', /Cursor ACP create_plan/);
  render(planView({ source: 'sdk-createPlan' }), true);
  assert.match(host.querySelector('.plan-source')?.textContent ?? '', /Cursor SDK createPlan/);
  window.happyDOM.abort();
});
