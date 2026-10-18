import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

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

test('transcript restores pending placement, handles stale rewinds, copy outcomes, and shell-output fallback', () => {
  const { window, root, sent, rewinds, transcript } = bootTranscript();
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'prompt', canRewind: true },
    { id: 'tool-1', role: 'tool', text: 'plain command output', turnId: 'user-1', tool: { name: 'Run', kind: 'shell', status: 'completed', target: 'echo hi' } },
    { id: 'tool-2', role: 'tool', text: 'completed: command succeeded', turnId: 'user-1', tool: { name: 'Run', kind: 'shell', status: 'completed', target: 'true' } },
    { id: 'error-1', role: 'error', text: 'failed', turnId: 'user-1' },
  ];
  transcript.render(messages, shell({ busy: true, timings: undefined }), strings('en'));
  const article = root.querySelector<HTMLElement>('[data-id="user-1"]')!;
  assert.equal(article.querySelector('.log-toggle .btn-label')?.textContent, strings('en').working);
  click(article.querySelector('.shell-tool-heading') as HTMLElement);
  assert.equal(article.querySelector('.shell-command-output')?.textContent, 'plain command output');
  click(article.querySelector('.shell-tool-heading') as HTMLElement);
  assert.equal(article.querySelector('.shell-command-output'), null, 'the second toggle closes the open details');
  const statusTool = root.querySelector<HTMLElement>('.shell-tool-heading[data-id="tool-2"]')!;
  click(statusTool);
  assert.equal(statusTool.closest('.tool-row-item')?.querySelector('.shell-command-output'), null, 'a status-only single-line result has no duplicate output block');
  click(statusTool);

  transcript.render(messages, shell({ busy: false, timings: undefined }), strings('en'));
  const edit = article.querySelector<HTMLButtonElement>('.edit-user')!;
  assert.equal(edit.disabled, false, 'the same prompt becomes editable again after the session stops');
  click(edit);
  const textarea = article.querySelector<HTMLTextAreaElement>('.edit-prompt')!;
  textarea.value = 'edited before detach';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  textarea.remove();
  click(article.querySelector('[data-action="rewind"]') as HTMLElement);
  assert.deepEqual(rewinds, [{ id: 'user-1', text: 'edited before detach' }], 'rewind uses cached text if its editor was detached');

  const copySource = article.querySelector<HTMLButtonElement>('.copy-user')!;
  click(copySource);
  const copyRequest = posted(sent, 'copy')?.requestId as string;
  transcript.copied(copyRequest, false);
  assert.equal(copySource.title, 'Copy failed');
  const logAction = root.querySelector<HTMLButtonElement>('[data-action="post"]');
  assert.ok(logAction);
  click(logAction);
  assert.ok(sent.some((message) => (message as { type?: string }).type === 'logs' || (message as { type?: string }).type === 'diagnose'));
  const malformedAction = window.document.createElement('button');
  malformedAction.dataset.action = 'post';
  root.append(malformedAction);
  const sentBeforeMalformedAction = sent.length;
  click(malformedAction);
  assert.equal(sent.length, sentBeforeMalformedAction, 'post actions without a type are ignored');

  const pending = root.querySelector('.pending')!;
  pending.remove();
  transcript.render(messages, shell({ busy: true, timings: undefined }), strings('en'));
  assert.equal(root.lastElementChild, pending, 'render reattaches a detached pending host');
  window.happyDOM.abort();
});
