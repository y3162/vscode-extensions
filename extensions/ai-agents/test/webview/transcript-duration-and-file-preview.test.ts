import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

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

test('transcript uses live thinking duration and renders a file row with no preview', (t) => {
  t.mock.method(Date, 'now', () => 2000);
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  const start = Date.now() - 1400;
  transcript.render([
    { id: 'user', role: 'user', text: 'checking', at: start },
    { id: 'thinking', role: 'status', text: 'working', at: start, turnId: 'user', meta: { type: 'thinking' } },
  ], shell({ busy: true }), strings('en'));
  assert.match(root.querySelector('.thought-toggle .btn-label')?.textContent ?? '', /Thinking 1s/);

  transcript.render([
    { id: 'user', role: 'user', text: 'file change' },
    { id: 'files', role: 'tool', text: 'changed', turnId: 'user', meta: { type: 'files', files: [{ path: 'src/a.ts', kind: 'update' }] } },
  ], shell(), strings('en'));
  assert.equal(root.querySelectorAll('.file-row').length, 1);
  assert.equal(root.querySelector('.file-inline-diff'), null);
  window.happyDOM.abort();
});

test('a restored running turn is visibly marked unknown instead of completed', (t) => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  transcript.render([{ id: 'user-unknown', role: 'user', text: 'unfinished prompt', at: 100 },
    { id: 'tool', turnId: 'user-unknown', role: 'tool', text: 'fixture command', tool: { kind: 'shell', name: 'fixture command', target: 'fixture command', status: 'running' } }], shell({ timings: [
    { id: 'user-unknown', startedAt: 100, waitMs: 0, status: 'unknown', intent: 'chat' },
  ] }), strings('en'));
  assert.match(root.querySelector('.turn-usage')?.textContent ?? '', /Run state unknown after reload/);
  assert.equal(root.querySelector('.turn-usage')?.hidden, false);
  assert.match(root.textContent ?? '', /Run state unknown/);
  assert.doesNotMatch(root.textContent ?? '', /Ran fixture command|Running fixture command/);
  window.happyDOM.abort();
});

test('transcript shows multiple waiting children and a child progress update', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  transcript.restoreExpanded(['user']);
  transcript.render([
    { id: 'user', role: 'user', text: 'Explore' },
    { id: 'child', role: 'status', text: '', turnId: 'user', meta: { type: 'subagent', subagent: {
      id: 'child', name: 'Explorer', status: 'running', background: true, progress: 'Reading files',
    } } },
  ], shell({ subagentWaiting: { parentTurnId: 'user', startedAt: 1, count: 2 } }), strings('en'));
  assert.equal(root.querySelector('.waiting-subagent')?.textContent, strings('en').waitingSubagents);
  assert.match(root.querySelector('.subagent')?.textContent ?? '', /Reading files/);
  (root.querySelector('.subagent') as HTMLButtonElement).click();
  window.happyDOM.abort();
});
