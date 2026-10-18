import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

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

function key(node: HTMLElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new node.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
}

test('a direct transcript covers streaming boundaries and commands that must not post', () => {
  const window = new Window();
  const root = window.document.createElement('main');
  window.document.body.append(root);
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const transcript = new Transcript(createDom(window.document), root, (message) => sent.push(message), () => {}, () => {}, () => {});
  const busy = shell({ busy: true, presence: 'running', statusText: 'Running' });
  const messages = (text: string, final = false): ViewMessage[] => [
    { id: 'user', role: 'user', text: 'write', at: 1 },
    { id: 'answer', role: 'assistant', text, at: 2, turnId: 'user', ...(final ? { final: true } : {}) },
  ];
  transcript.render(messages(`${'a'.repeat(20)} **z**`), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md strong')?.textContent, 'z');
  transcript.render(messages('b'.repeat(4000)), busy, strings('en'));
  const node = root.querySelector('.answer .md')?.firstChild;
  transcript.render(messages('b'.repeat(4000)), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.firstChild, node);
  transcript.render(messages(`${'b'.repeat(4000)}Z`), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.textContent?.endsWith('Z'), true);
  transcript.render(messages('c'.repeat(4000)), busy, strings('en'));
  assert.equal(root.querySelector('.answer .md')?.textContent, 'c'.repeat(4000));
  transcript.render(messages(`${'c'.repeat(20)}\n\n**done**`, true), shell(), strings('en'));
  assert.equal(root.querySelector('strong')?.textContent, 'done');
  const button = window.document.createElement('button');
  button.dataset.action = 'noop';
  root.append(button);
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.length, 0);
  root.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.length, 0);
});
