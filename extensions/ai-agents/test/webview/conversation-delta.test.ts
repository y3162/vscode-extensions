import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createDom } from '../../src/webview/dom.js';
import { strings } from '../../src/webview/strings.js';
import { SubagentPanel } from '../../src/webview/subagents.js';
import { Transcript } from '../../src/webview/transcript.js';
import type { ViewMessage, ViewShell, ViewSubagent } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: null, modelSettings: 'next-send',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }], mode: 'agent', showMode: false,
    sandboxChoices: [], sandbox: 'workspace-write', approvalChoices: [], approval: 'never', showApproval: false,
    webSearchChoices: [], webSearch: '', showWebSearch: false, network: false, showNetwork: false,
    backend: 'cli', additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false,
    conversationId: 'front', queue: [], changes: [], planView: null, timings: [], subagents: [],
    subagentWaiting: null, terminals: [], additions: 0, deletions: 0, sessions: [], usage: null,
    permission: null, plan: null, question: null, activeFile: null, locale: 'en',
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], ...extra,
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('tool rows show running, failed, and done as text', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const root = dom.el('main');
  window.document.body.append(root);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {});
  const tool = (status: 'running' | 'error' | 'completed'): ViewMessage => ({
    id: `tool-${status}`, role: 'tool', text: 'detail', turnId: 'user',
    tool: { name: 'Read', kind: 'read', status, target: 'src/a.ts' },
  });
  transcript.render([
    { id: 'user', role: 'user', text: 'look', at: 1 },
    tool('running'),
  ], shell(), strings('en'));
  assert.equal(root.querySelector('.tool-state')?.textContent, 'Running');
  transcript.render([
    { id: 'user', role: 'user', text: 'look', at: 1 },
    tool('error'),
    { id: 'answer', role: 'assistant', text: 'done', at: 2, turnId: 'user', final: true },
  ], shell(), strings('en'));
  click(root.querySelector('.log-toggle') as HTMLElement);
  assert.equal(root.querySelector('.tool-state')?.textContent, 'Failed');
  transcript.render([
    { id: 'user', role: 'user', text: 'look', at: 1 },
    tool('completed'),
    { id: 'answer', role: 'assistant', text: 'done', at: 2, turnId: 'user', final: true },
  ], shell(), strings('en'));
  assert.equal(root.querySelector('.tool-state')?.textContent, 'Done');
  window.happyDOM.abort();
});

test('a completed subagent stays in the turn after the dock hides it', () => {
  const window = new Window();
  const dom = createDom(window.document);
  const dock = dom.el('div');
  const root = dom.el('main');
  window.document.body.append(dock, root);
  const child: ViewSubagent = {
    id: 'child', parentTurnId: 'user', name: 'Explorer', task: 'Map the seam', status: 'completed', background: false,
    resultPreview: 'Mapped',
  };
  new SubagentPanel(dom, dock, () => {}, () => {}).render(shell({ subagents: [child] }), strings('en'), true);
  assert.equal(dock.hidden, true);
  const transcript = new Transcript(dom, root, () => {}, () => {}, () => {}, () => {}, () => {}, (id) => id);
  transcript.render([
    { id: 'user', role: 'user', text: 'look', at: 1 },
    { id: 'child-row', role: 'tool', text: 'Mapped', turnId: 'user', meta: { type: 'subagent', subagent: child } },
    { id: 'answer', role: 'assistant', text: 'done', at: 2, turnId: 'user', final: true },
  ], shell({ subagents: [child] }), strings('en'));
  click(root.querySelector('.log-toggle') as HTMLElement);
  assert.equal(root.querySelector('.subagent.completed')?.textContent?.includes('Explorer'), true);
  window.happyDOM.abort();
});
