import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createApp } from '../../src/webview/app.js';
import type { ViewMessage, ViewPlan, ViewShell, VsCodeApi } from '../../src/protocol.js';
import { strings } from '../../src/webview/strings.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: '', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'CLI', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backend: 'cli', additionalDirectories: [], autoApprove: false, steer: false,
    interactiveApproval: false, queue: [], changes: [], additions: 0, deletions: 0, sessions: [], usage: null,
    permission: null, plan: null, question: null, conversationId: 'front', planView: null, timings: [], subagents: [],
    terminals: [], activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }], images: true, ...extra,
  };
}

function plan(extra: Partial<ViewPlan> = {}): ViewPlan {
  return {
    id: 'plan-1', revision: 1, phase: 'ready', name: 'Ship it', overview: 'First line of the plan overview that should stay visible.',
    markdown: 'Body', todos: [], source: 'assistant-text', buildModelId: 'gpt', buildModelLabel: 'GPT', buildParams: [],
    showBuildModel: false, canBuild: false, error: 'Not ready', history: [], ...extra,
  };
}

function boot() {
  const window = new Window();
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  const vscode: VsCodeApi = { postMessage(message) { sent.push(message); }, getState: () => ({ page: 'chat' }), setState() {} };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  return { window, document: window.document, emit, sent };
}

const messages: ViewMessage[] = [
  { id: 'user', role: 'user', text: 'Fix the layout', attachments: ['/workspace/src/app.ts'], at: 1_000 },
  { id: 'blank', role: 'status', text: '  ', at: 1_100, turnId: 'user', meta: { type: 'thinking' } },
  { id: 'thought', role: 'status', text: 'Check the column', at: 1_200, turnId: 'user', meta: { type: 'thinking' } },
  { id: 'sh', role: 'tool', text: 'completed: npm test\nok', at: 2_000, turnId: 'user', tool: { kind: 'shell', name: 'command', status: 'error', target: 'npm test', exitCode: 1 } },
  { id: 'answer', role: 'assistant', text: 'Done', at: 5_000, turnId: 'user', final: true },
];

test('the spec column, user card, activity group, and composer bar are in the production stylesheet', () => {
  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /--agent-column:\s*min\(100%,\s*640px\)/);
  assert.match(css, /--agent-radius:\s*12px/);
  assert.match(css, /padding-left:\s*max\(16px,\s*calc\(\(100% - 640px\) \/ 2\)\)/);
  assert.match(css, /\.bubble\.user-card\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.composer-card \.composer-row\s*\{[^}]*height:\s*40px/);
  assert.match(css, /\.composer-card \.send[^}]*width:\s*24px/);
  assert.match(css, /\.shell-command-output\s*\{[^}]*max-height:\s*8em/);
  assert.match(css, /var\(--vscode-contrastBorder,\s*var\(--agent-stroke\)\)/);
});

test('a user message is a full-width card and empty thinking is absent', () => {
  const { document, emit } = boot();
  emit(shell({ timings: [{ id: 'user', startedAt: 1_000, endedAt: 5_000, waitMs: 0, status: 'completed', intent: 'chat' }] }), messages);
  const card = document.querySelector<HTMLElement>('.bubble.user-card')!;
  assert.equal(card.querySelector('.user-body')?.textContent, 'Fix the layout');
  assert.equal(card.querySelector('.chip')?.textContent, 'app.ts');
  assert.equal(card.querySelector('.chip')?.getAttribute('title'), '/workspace/src/app.ts');
  assert.equal(document.querySelector('.thinking')?.textContent?.includes('Check the column'), true);
  assert.equal([...document.querySelectorAll('.thinking')].some((node) => node.textContent?.trim() === ''), false);
  const toggle = document.querySelector<HTMLButtonElement>('[data-action="toggle-log"]')!;
  assert.match(toggle.textContent ?? '', /Worked for 4s/);
  assert.equal(document.querySelector('.log')?.hidden, true);
  toggle.click();
  const group = document.querySelector('details.ran')!;
  assert.match(group.querySelector('.activity-verb')?.textContent ?? '', /Failed npm test|Failed/);
  assert.match(document.querySelector('.tool-reason')?.textContent ?? '', /npm test/);
  assert.equal(group.querySelector('.shell-command-output'), null);
  const tool = group.querySelector<HTMLButtonElement>('.shell-tool-heading')!;
  tool.click();
  assert.equal(document.querySelector('details.ran .shell-command-output')?.textContent, 'ok');
  assert.equal(document.querySelector('.answer')?.textContent?.includes('Done'), true);
  assert.equal(document.querySelector('.change-bar')?.hidden, true);
});

test('approval buttons follow allow, session, deny and a blocked plan names its reason', () => {
  const { document, emit } = boot();
  emit(shell({
    permission: { token: 'token-1', request: { id: 'perm', title: 'Run npm test', detail: 'npm test', kind: 'shell' } },
    planView: plan(),
  }));
  const decisions = [...document.querySelectorAll<HTMLButtonElement>('.pending-card .card-actions button')].map((button) => button.dataset.decision);
  assert.deepEqual(decisions, ['allow-once', 'allow-session', 'deny']);
  assert.equal(document.querySelector('.pending-card .primary')?.dataset.decision, 'allow-once');
  assert.match(document.querySelector('.pending-card .primary')?.getAttribute('aria-label') ?? '', /Allow, npm test/);
  assert.equal(document.querySelector('.pending-target')?.textContent, 'npm test');
  const build = document.querySelector<HTMLButtonElement>('.build')!;
  assert.equal(build.disabled, true);
  assert.match(build.getAttribute('aria-label') ?? '', /not ready to build/);
  const bar = document.querySelector('.composer-bar')!;
  assert.equal(bar.querySelector('.mode')?.textContent?.includes('Agent'), true);
  assert.equal(bar.querySelector('.composer-right .send') !== null, true);
  assert.equal(bar.querySelector('.composer-left .attach') !== null, true);
});

test('one changed file is named on the review bar and a missing folder explains why send is blocked', () => {
  const { document, emit } = boot();
  emit(shell({
    cwd: '',
    changes: [{ path: 'src/app.ts', name: 'app.ts', kind: 'update', additions: 2, deletions: 1, canRevert: true, canDiff: true, synthetic: false, patch: Array.from({ length: 14 }, (_, index) => `+line ${index}`).join('\n') }],
    additions: 2, deletions: 1,
  }));
  assert.match(document.querySelector('.change-toggle')?.textContent ?? '', /app\.ts/);
  assert.match(document.querySelector('.change-toggle')?.textContent ?? '', /\+2/);
  document.querySelector<HTMLButtonElement>('.change-toggle')!.click();
  const diff = document.querySelector('.review-diff')?.textContent ?? '';
  assert.equal(diff.includes('+line 11'), true);
  assert.equal(diff.includes('+line 12'), false);
  assert.equal(document.querySelector('.composer-note')?.hidden, false);
  assert.match(document.querySelector('.composer-note')?.textContent ?? '', /Open a folder/);
});

test('japanese copy keeps the work-time and mode labels', () => {
  const copy = strings('ja');
  assert.equal(copy.worked, '作業時間');
  assert.equal(copy.thinking, '思考中');
  assert.equal(copy.interrupted, '中断');
  assert.equal(copy.allow, '許可');
});
