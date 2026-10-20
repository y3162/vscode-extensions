import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

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

test('plans render every phase, and a disabled build does not post', () => {
  const { sent, emit, document, persisted, input } = boot();
  const plan = (phase: ViewShell['planView'] extends infer T ? T extends { phase: infer P } ? P : never : never, extra: Record<string, unknown> = {}) => ({
    id: 'plan-1', revision: 4, phase, markdown: 'Body', todos: [], source: 'assistant-text' as const,
    buildModelId: 'gpt', buildModelLabel: 'GPT', buildParams: [], showBuildModel: false, canBuild: false, history: [], ...extra,
  });
  emit(shell());
  click(visible(document, '.new-chat'));
  assert.equal(document.querySelector('.plan-slot')?.hidden, true);
  for (const [phase, label] of [['planning', 'Updating plan'], ['revising', 'Updating plan'], ['building', 'Building'], ['implemented', 'Build finished'], ['ready', 'Ready to build'], ['unknown', 'Plan state could not be checked after reload'], ['idle', 'assistant-text']] as const) {
    emit(shell({ planView: plan(phase) }), [{ id: 'user', role: 'user', text: 'plan', at: 1 }]);
    assert.match(document.querySelector('.plan-phase')?.textContent ?? '', new RegExp(label));
  }
  emit(shell({ planView: plan('unknown', { showBuildModel: true }) }));
  assert.equal((document.querySelector('.build') as HTMLButtonElement).disabled, true);
  assert.equal(document.querySelector('.plan-actions .pill'), null);
  click(document.querySelector('.build') as HTMLElement);
  assert.equal(posted(sent, 'buildPlan'), undefined);
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
  assert.match(document.querySelector('.plan-view-toggle')?.textContent ?? '', /View Plan/);
  assert.equal(document.querySelector('.plan-body'), null);
  click(document.querySelector('.plan-view-toggle') as HTMLElement);
  assert.match(document.querySelector('.plan-source')?.textContent ?? '', /Plan source: Assistant message fallback/);
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
  const beforeSource = document.querySelector('.plan-view');
  emit(shell({ planView: plan('ready', { source: 'app-server-plan' }) }));
  assert.notEqual(document.querySelector('.plan-view'), beforeSource);
  assert.match(document.querySelector('.plan-source')?.textContent ?? '', /Plan source: Codex App Server plan item/);
  assert.doesNotMatch(document.querySelector('.plan-view')?.textContent ?? '', /\b\d+ agents?\b/i);
  const sourceOnly = document.querySelector('.plan-view');
  const detailedPlan = plan('ready', {
    source: 'app-server-plan', restored: true, error: 'Could not revise', overview: 'Overview', showBuildModel: true, canBuild: false,
    todos: [
      { content: 'done', status: 'completed' }, { content: 'finished', status: 'done' },
      { content: 'working', status: 'in_progress' }, { content: 'started', status: 'inProgress' }, { content: 'later', status: 'pending' },
    ],
    files: ['src/app.ts', 'README.md'],
    history: [{ revision: 1, markdown: 'Old' }, { revision: 3, name: 'Named', markdown: 'Named body' }],
  });
  const planMessage = [{ id: 'user', role: 'user', text: 'plan', at: 1 }];
  emit(shell({ planView: detailedPlan }), planMessage);
  assert.notEqual(document.querySelector('.plan-view'), sourceOnly);
  assert.match(document.querySelector('.plan-body')?.textContent ?? '', /Overview/);
  assert.match(document.querySelector('.todo-progress')?.textContent ?? '', /2 \/ 5/);
  assert.equal(document.querySelectorAll('.plan-todos .done').length, 2);
  assert.equal(document.querySelectorAll('.plan-todos .active').length, 2);
  assert.deepEqual([...document.querySelectorAll('.plan-files li')].map((node) => node.textContent), ['src/app.ts', 'README.md']);
  assert.match(document.querySelector('.plan-history')?.textContent ?? '', /Named/);
  const stable = document.querySelector('.plan-view');
  emit(shell({ planView: detailedPlan }), planMessage);
  assert.equal(document.querySelector('.plan-view'), stable);
  input().value = 'Keep this draft while viewing the plan';
  input().dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
  click(document.querySelector('.plan-view-toggle') as HTMLElement);
  assert.equal(document.querySelector('.plan-body'), null);
  assert.match(document.querySelector('.plan-view-toggle')?.textContent ?? '', /View Plan/);
  assert.equal(input().value, 'Keep this draft while viewing the plan');
  assert.equal((persisted() as { planViewKey?: string }).planViewKey, undefined);
  click(document.querySelector('.plan-view-toggle') as HTMLElement);
  assert.match(document.querySelector('.plan-source')?.textContent ?? '', /Plan source: Codex App Server plan item/);
  emit(shell({ mode: 'plan', planView: plan('ready', { canBuild: true, showBuildModel: true }) }));
  assert.equal(document.querySelector('#prompt')?.getAttribute('placeholder'), 'Revise the plan…');
  emit(shell({ showMode: false, planView: null }));
  assert.equal(document.querySelector('.mode')?.hidden, true);
  assert.equal(document.querySelector('.plan-slot')?.hidden, true);
});

test('restored plan details are scoped to their conversation and do not start Build', () => {
  const saved = boot({ page: 'chat', draft: 'saved composer draft', planViewKey: 'front\u0000plan-1' });
  const plan = {
    id: 'plan-1', revision: 2, phase: 'ready' as const, markdown: 'Detailed plan body', todos: [], source: 'assistant-text' as const,
    buildModelId: 'gpt', buildModelLabel: 'GPT', buildParams: [], showBuildModel: true, canBuild: true, history: [],
  };
  saved.emit(shell({ planView: plan }));
  assert.match(saved.document.querySelector('.plan-body')?.textContent ?? '', /Detailed plan body/);
  assert.match(saved.document.querySelector('.plan-view-toggle')?.textContent ?? '', /Back to chat/);
  assert.equal(saved.input().value, 'saved composer draft');
  assert.equal(posted(saved.sent, 'buildPlan'), undefined);

  const otherConversation = boot({ page: 'chat', planViewKey: 'other\u0000plan-1' });
  otherConversation.emit(shell({ planView: plan }));
  assert.equal(otherConversation.document.querySelector('.plan-body'), null);
  assert.match(otherConversation.document.querySelector('.plan-view-toggle')?.textContent ?? '', /View Plan/);
});
