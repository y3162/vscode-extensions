import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createDom } from '../../src/webview/dom.js';
import { createApp } from '../../src/webview/app.js';
import { strings } from '../../src/webview/strings.js';
import { renderSubagentDetail, SubagentPanel } from '../../src/webview/subagents.js';
import { buildTurns } from '../../src/webview/turns.js';
import { buildShell } from '../../src/view-state.js';
import { capabilitiesFor, defaultControls } from '../../src/capabilities.js';
import { emptyPlanState, type ChatState } from '../../src/types.js';
import type { MessageDiff, ViewMessage, ViewShell, ViewSubagent, VsCodeApi } from '../../src/protocol.js';

function fixture() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  return { window, dom, host };
}

const child = (id: string, status: ViewSubagent['status']): ViewSubagent => ({
  id, parentTurnId: 'turn-1', name: 'Explorer', task: `Map ${id} coverage`, model: 'gpt-6-luna',
  status, background: true, startedAt: 1000, ...(status === 'completed' ? { endedAt: 2400, durationMs: 1400, resultPreview: `Result ${id}` } : {}),
  ...(status === 'running' ? { progress: 'Reading SDK seams' } : {}),
});

test('subagent panel deduplicates IDs, preserves collapse choice, and opens the selected child', () => {
  const { dom, host } = fixture();
  let opened = '';
  let expansion: boolean | undefined;
  const panel = new SubagentPanel(dom, host, (id) => { opened = id; }, (expanded) => { expansion = expanded; });
  const shell = { subagents: [child('alpha', 'running'), child('beta', 'completed'), child('alpha', 'running')] } as ViewShell;
  panel.render(shell, strings('en'), true);
  assert.match(host.querySelector('.subagent-panel-heading')?.textContent ?? '', /2 background subagents/);
  assert.equal(host.querySelectorAll('.subagent-panel-row').length, 2);
  assert.equal(host.querySelector('.subagent-panel-rows')?.hidden, false);
  assert.equal(host.querySelector('.subagent-panel-row.running .subagent-panel-progress')?.textContent, 'Reading SDK seams');
  (host.querySelector('.subagent-panel-heading') as HTMLButtonElement).click();
  assert.equal(expansion, false);
  panel.render(shell, strings('en'), false);
  assert.equal((host.querySelector('.subagent-panel-heading') as HTMLButtonElement).getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('.subagent-panel-rows')?.hidden, true);
  (host.querySelector('.subagent-panel-rows') as HTMLElement).scrollTop = 12;
  panel.render(shell, strings('en'), true);
  assert.equal(host.querySelector('.subagent-panel-rows')?.scrollTop, 12);
  (host.querySelector('[data-subagent-id="beta"] .subagent-panel-open') as HTMLButtonElement).click();
  assert.equal(opened, 'beta');
});

test('subagent rows retain terminal states, Japanese labels, and narrow-sidebar layout constraints', () => {
  const records = [
    child('running', 'running'), child('done', 'completed'), child('failed', 'error'),
    child('cancelled', 'cancelled'), child('unknown', 'unknown'),
  ];
  const css = readFileSync(path.join(process.cwd(), 'src/webview/styles.css'), 'utf8');
  for (const width of [300, 390]) {
    const { window, dom, host } = fixture();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const panel = new SubagentPanel(dom, host, () => {}, () => {});
    panel.render({ subagents: records.map((item) => ({ ...item, background: false })) } as ViewShell, strings('ja'), true);
    assert.equal(host.querySelectorAll('.subagent-panel-row').length, 5);
    assert.match(host.querySelector('.subagent-panel-heading')?.textContent ?? '', /5 サブエージェント/);
    assert.equal(host.querySelector('.subagent-mark.completed')?.textContent, '✓');
    assert.equal(host.querySelector('.subagent-mark.error')?.textContent, '×');
    assert.equal(host.querySelector('.subagent-mark.cancelled')?.textContent, '×');
    assert.equal(host.querySelector('.subagent-mark.unknown')?.textContent, '?');
  }
  assert.match(css, /\.subagent-panel-rows\s*\{[^}]*max-height:[^;]+;[^}]*overflow:\s*auto/s);
  assert.match(css, /\.subagent-panel-open\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.subagent-panel-title[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /var\(--vscode-foreground\)/);
  assert.match(css, /var\(--vscode-sideBar-background\)/);
});

test('child Stop stays hidden when the backend does not expose an exact child-stop capability', () => {
  const { dom, host } = fixture();
  const panel = new SubagentPanel(dom, host, () => {}, () => {});
  const active = child('active', 'running');
  const unavailable = child('unavailable', 'running');
  panel.render({ subagents: [active, unavailable] } as ViewShell, strings('en'), true);
  assert.equal(host.querySelectorAll('.subagent-stop').length, 0);
  assert.equal(host.querySelector('[data-subagent-id="unavailable"] .subagent-stop'), null);
});

test('child details show only captured fields and child events stay out of the parent transcript', () => {
  const { dom, host } = fixture();
  let returned = false;
  const item = child('alpha', 'completed');
  const messages: ViewMessage[] = [
    { id: 'user', role: 'user', text: 'Find coverage', turnId: 'user' },
    { id: 'tool', role: 'tool', text: 'rg tests\n12 matches', turnId: 'user', subagentId: 'alpha', tool: { kind: 'search', name: 'rg', status: 'completed', target: 'tests' } },
    { id: 'answer', role: 'assistant', text: 'Found 12 matches.', turnId: 'user', subagentId: 'alpha', final: true },
    { id: 'parent-answer', role: 'assistant', text: 'Coverage is mapped.', turnId: 'user', final: true },
  ];
  renderSubagentDetail(dom, host, item, messages, strings('en'), 'en', () => { returned = true; });
  assert.match(host.textContent ?? '', /Map alpha coverage/);
  assert.match(host.textContent ?? '', /gpt-6-luna/);
  assert.match(host.textContent ?? '', /1s/);
  assert.match(host.textContent ?? '', /12 matches/);
  assert.match(host.textContent ?? '', /Found 12 matches/);
  (host.querySelector('.subagent-back') as HTMLButtonElement).click();
  assert.equal(returned, true);
  const turns = buildTurns(messages, false, false);
  assert.equal(turns[0]?.answer?.text, 'Coverage is mapped.');
  assert.equal(turns[0]?.log.length, 0, 'child-only tools and answers are rendered in the selected detail view');
});

test('child duration identifies Backend-reported values and Extension Host estimates', () => {
  const reported = fixture();
  renderSubagentDetail(reported.dom, reported.host, child('reported', 'completed'), [], strings('en'), 'en', () => {});
  assert.equal(reported.host.querySelector('.subagent-elapsed')?.getAttribute('title'), 'Backend-reported duration');

  const estimated = fixture();
  renderSubagentDetail(estimated.dom, estimated.host, { ...child('estimated', 'completed'), durationMs: undefined }, [], strings('ja'), 'ja', () => {});
  assert.equal(estimated.host.querySelector('.subagent-elapsed')?.getAttribute('title'), 'Extension Host内の観測時刻からの概算');
});

test('sidebar detail navigation keeps the parent scroll and draft while child updates continue', async () => {
  const { window, dom, host } = fixture();
  host.id = 'app';
  const state: ChatState = {
    selection: { provider: 'codex', cwd: '/workspace', model: 'gpt-6-luna' },
    busy: true, messages: [], queue: [], status: 'running', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [{ id: 'turn-1', startedAt: 1, status: 'running', waitMs: 0, mode: 'agent', model: 'gpt-6-luna', intent: 'chat' }],
    subagents: [{ id: 'child-1', parentTurnId: 'turn-1', name: 'Explorer', task: 'Map child-1 coverage', model: 'gpt-6-luna', status: 'running', background: true, startedAt: 1000, progress: 'Reading session seams' }], terminals: [],
    subagentWaiting: { parentTurnId: 'turn-1', startedAt: 100 },
  };
  const makeShell = (progress: string) => buildShell({
    state: { ...state, subagents: [{ ...state.subagents[0]!, progress }] },
    folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'GPT-6 Luna', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls: defaultControls('codex', 'app-server'), locale: 'en',
    sessionId: 'thread-1', conversationId: 'conversation-1',
    tokens: { permission: null, plan: null, question: null }, backends: { codex: 'app-server', cursor: 'sdk' },
  });
  const user: ViewMessage = { id: 'user', role: 'user', text: 'Map coverage', turnId: 'user', at: 1 };
  const childEvent: ViewMessage = {
    id: 'child-log', role: 'tool', text: 'rg tests\n12 matches', turnId: 'user', subagentId: 'child-1',
    tool: { kind: 'search', name: 'rg', status: 'completed' },
  };
  let saved: unknown = { page: 'chat' };
  const vscode: VsCodeApi = {
    postMessage() {},
    getState: () => saved,
    setState(value) { saved = value; },
  };
  const app = createApp(vscode, { document: window.document });
  const sendState = (revision: number, shell: ViewShell, messages: MessageDiff, full = false) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', revision, full, shell, messages } }));
  };
  const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const firstMessages: MessageDiff = { removed: [], upserts: [user, childEvent], order: [user.id, childEvent.id] };
  sendState(1, makeShell('Reading session seams'), firstMessages, true);
  await frame();
  assert.equal(window.document.querySelector('.waiting-subagent')?.textContent, 'Waiting for subagent');
  const thread = window.document.querySelector('.thread') as HTMLElement;
  Object.defineProperties(thread, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 500 } });
  thread.scrollTop = 150;
  thread.dispatchEvent(new window.Event('scroll'));
  const input = window.document.querySelector('#prompt') as HTMLTextAreaElement;
  input.value = 'keep this draft';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const heading = window.document.querySelector('.subagent-panel-heading') as HTMLButtonElement;
  heading.click();
  sendState(2, makeShell('Mapping tests'), { removed: [], upserts: [], order: [user.id, childEvent.id] });
  await frame();
  assert.equal((window.document.querySelector('.subagent-panel-heading') as HTMLButtonElement).getAttribute('aria-expanded'), 'false');
  (window.document.querySelector('.subagent-panel-heading') as HTMLButtonElement).click();
  (window.document.querySelector('[data-subagent-id="child-1"] .subagent-panel-open') as HTMLButtonElement).click();
  assert.equal(thread.hidden, true);
  assert.equal(window.document.querySelector('.subagent-detail-host')?.hidden, false);
  assert.match(window.document.querySelector('.subagent-detail-host')?.textContent ?? '', /rg tests/);
  sendState(3, makeShell('Mapping tests and fixtures'), { removed: [], upserts: [{ ...childEvent, text: 'rg tests\n14 matches' }], order: [user.id, childEvent.id] });
  await frame();
  assert.match(window.document.querySelector('.subagent-detail-host')?.textContent ?? '', /14 matches/);
  assert.equal(input.value, 'keep this draft');
  (window.document.querySelector('.subagent-back') as HTMLButtonElement).click();
  assert.equal(thread.hidden, false);
  assert.equal(thread.scrollTop, 150);
  assert.equal(input.value, 'keep this draft');
  app.destroy();
});
