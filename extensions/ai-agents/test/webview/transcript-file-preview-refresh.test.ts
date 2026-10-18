import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewShell } from '../../src/protocol.js';

import { createDom } from '../../src/webview/dom.js';

import { strings } from '../../src/webview/strings.js';

import { Transcript } from '../../src/webview/transcript.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
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
    planView: null, timings: [], subagents: [], terminals: [], activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function bootTranscript() {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  return { window, root, transcript };
}

test('transcript replaces a same-size changed file preview and labels a running tool', () => {
  const { window, root, transcript } = bootTranscript();
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'inspect' },
    { id: 'file-1', role: 'tool', text: 'changed', turnId: 'user-1', meta: {
      type: 'files', files: [{ path: 'src/a.ts', kind: 'update', preview: [{ kind: 'context', line: 1, text: 'before' }] }],
    } },
  ];
  transcript.render(messages, shell(), strings('en'));
  const previousLine = root.querySelector('.diff-preview-line');
  const updated = structuredClone(messages);
  const fileMessage = updated[1];
  assert.equal(fileMessage?.meta?.type, 'files');
  if (fileMessage?.meta?.type === 'files') fileMessage.meta.files[0]!.preview![0]!.text = 'after';
  transcript.render(updated, shell(), strings('en'));
  assert.notEqual(root.querySelector('.diff-preview-line'), previousLine);
  assert.equal(root.querySelector('.diff-preview-line code')?.textContent, 'after');

  transcript.render([
    { id: 'user-2', role: 'user', text: 'run' },
    { id: 'running-tool', role: 'tool', text: 'running', turnId: 'user-2', tool: { name: 'Search', kind: 'search', status: 'running' } },
  ], shell({ busy: true }), strings('en'));
  assert.equal(root.querySelector('.log-toggle .btn-label')?.textContent, 'Search…');
  window.happyDOM.abort();
});
