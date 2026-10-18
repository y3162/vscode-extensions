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

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function bootTranscript() {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  return { window, root, transcript };
}

test('transcript rejects a busy rewind event and safely skips refresh before labels are ready', () => {
  const { window, root, transcript } = bootTranscript();
  const internal = transcript as unknown as { shell: ViewShell | null; labels: null; refreshOpenTurn(): void };
  internal.refreshOpenTurn();
  internal.shell = shell();
  internal.refreshOpenTurn();

  transcript.render([{ id: 'user-1', role: 'user', text: 'prompt', canRewind: true }], shell({ busy: true }), strings('en'));
  const edit = root.querySelector<HTMLButtonElement>('.edit-user')!;
  edit.disabled = false; // Dispatch through the listener while retaining the busy shell state.
  click(edit);
  assert.equal(root.querySelector('.edit-prompt'), null, 'a stale or synthetic edit click cannot start rewind while busy');
  window.happyDOM.abort();
});
