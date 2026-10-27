import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import { createApp } from '../../src/webview/app.js';

import { createDom } from '../../src/webview/dom.js';

import { Transcript } from '../../src/webview/transcript.js';

import { buildTurns } from '../../src/webview/turns.js';

import { strings } from '../../src/webview/strings.js';

import type { ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

function shell(extra: Partial<ViewShell> = {}): ViewShell {
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: 'Ready', sessionTitle: 'New chat', modelLabel: 'gpt', effortLabel: 'High', modelSettings: 'new-session',
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [{ name: 'workspace', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [{ id: 'workspace-write', label: 'Workspace write' }], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backendChoices: [{ id: 'sdk', label: 'SDK' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [], changes: [],
    additions: 0, deletions: 0, sessions: [], usage: null, permission: null, plan: null, question: null,
    conversationId: 'front', planView: null, timings: [], subagents: [], terminals: [],
    activeFile: null, locale: 'en', providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }], ...extra,
  };
}

function posted(sent: unknown[], type: string): Record<string, unknown> | undefined {
  return [...sent].reverse().find((message) => message && typeof message === 'object' && 'type' in message && message.type === type) as Record<string, unknown> | undefined;
}

function mount() {
  const window = new Window();
  window.document.documentElement.lang = 'en';
  window.document.body.innerHTML = '<div id="app"></div>';
  const sent: unknown[] = [];
  let persisted: unknown;
  const vscode: VsCodeApi = { postMessage(message) { sent.push(message); }, getState: () => null, setState(state) { persisted = state; } };
  const app = createApp(vscode, { document: window.document });
  const emit = (next: ViewShell, messages: ViewMessage[] = []) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'state', revision: 1, full: true, shell: next, messages: { removed: [], upserts: messages, order: messages.map((message) => message.id) } },
    }));
    app.flush();
  };
  return { window, sent, app, emit, persisted: () => persisted as { draft?: string }, input: () => window.document.querySelector('textarea') as HTMLTextAreaElement };
}

function visible(document: Document, selector: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((node) => !node.closest('[hidden]'));
  assert.ok(found, selector);
  return found;
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

test('file theme CSS escapes render as glyphs and invalid code points fall back safely', () => {
  const { window, emit } = mount();
  for (const [fontCharacter, expected] of [['\\E023', '\uE023'], ['\uE023', '\uE023'], ['\\110000', 'NO'], ['\\D800', 'NO']]) {
    emit(shell({ changes: [{ path: 'note.txt', name: 'note.txt', kind: 'update', canRevert: false, canDiff: false, synthetic: false,
      icon: { type: 'font', fontCharacter, fontFamily: 'seti' } }] }));
    assert.equal(window.document.querySelector('.change-file .file-icon, .change-file .file-badge')?.textContent, expected);
  }
});

test('the view title does not duplicate home and chat actions', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[]; menus?: { 'view/title'?: { command: string }[] } };
  };
  const titled = manifest.contributes.menus?.['view/title']?.map((item) => item.command) ?? [];
  for (const command of ['ai-agents.newChat', 'ai-agents.showHistory', 'ai-agents.showSettings', 'ai-agents.stop', 'ai-agents.signIn', 'ai-agents.apiKey', 'ai-agents.diagnose', 'ai-agents.usage', 'ai-agents.instructions', 'ai-agents.showLogs']) {
    assert.equal(titled.includes(command), false, command);
  }
  const commands = manifest.contributes.commands.map((item) => item.command);
  for (const command of ['ai-agents.newChat', 'ai-agents.showHistory', 'ai-agents.showSettings', 'ai-agents.stop', 'ai-agents.signIn', 'ai-agents.diagnose']) {
    assert.equal(commands.includes(command), true, command);
  }
});

test('copy uses original Markdown/code/user/tool text and reports host success or failure', () => {
  const { window, sent, emit } = mount();
  const answer = '**日本語 😀**\n\n```ts\nconst x = "λ";\nconsole.log(x);\n```';
  emit(shell(), [
    { id: 'u', role: 'user', text: '質問\n二行', at: 1 },
    { id: 't', role: 'tool', text: 'stdout\nstderr 😀', at: 2, tool: { name: 'shell', kind: 'shell', status: 'completed' } },
    { id: 'a', role: 'assistant', text: answer, final: true, at: 3 },
  ]);
  assert.ok(window.document.querySelector('.answer > .message-actions > .copy-answer'));
  assert.ok(window.document.querySelector('.user-row > .message-actions > .copy-user'));
  click(window.document.querySelector('.copy-answer')!);
  let request = posted(sent, 'copy')!; assert.equal(request.text, answer);
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: request.requestId, ok: true } }));
  assert.match(window.document.querySelector('.copy-answer')!.getAttribute('title')!, /Copied/);
  click(window.document.querySelector('[data-action="copy-code"]')!);
  request = posted(sent, 'copy')!; assert.equal(request.text, 'const x = "λ";\nconsole.log(x);');
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'copyResult', requestId: request.requestId, ok: false } }));
  assert.match(window.document.querySelector('[data-action="copy-code"]')!.getAttribute('title')!, /failed/);
  click(window.document.querySelector('.user-row [data-action="copy-source"]')!);
  assert.equal(posted(sent, 'copy')!.text, '質問\n二行');
  click(window.document.querySelector('[data-action="toggle-tool"]')!);
  click(window.document.querySelector('.tool-row-item [data-action="copy-source"]')!);
  assert.equal(posted(sent, 'copy')!.text, 'stdout\nstderr 😀');
});

test('long assistant output appends while streaming and renders Markdown when complete', () => {
  const window = new Window();
  const root = window.document.createElement('main');
  window.document.body.append(root);
  const transcript = new Transcript(createDom(window.document), root, () => {}, () => {}, () => {}, () => {});
  const busy = shell({ busy: true, presence: 'running', statusText: 'Running' });
  const messages = (text: string): ViewMessage[] => [
    { id: 'user', role: 'user', text: 'Write a long answer', at: 1 },
    { id: 'answer', role: 'assistant', text, turnId: 'user', at: 2 },
  ];

  let output = '';
  const chunk = '0123456789abcdefghij'.repeat(40);
  for (let index = 0; index < 100; index += 1) {
    output += chunk;
    transcript.render(messages(output), busy, strings('en'));
  }
  const markdown = root.querySelector<HTMLElement>('.answer .md')!;
  const streamedNode = markdown.firstChild;
  assert.equal(output.length, 80_000);
  assert.equal(markdown.textContent?.length, output.length);
  assert.equal(markdown.textContent?.slice(0, 40), output.slice(0, 40));
  assert.equal(markdown.classList.contains('is-streaming'), true);
  assert.equal(streamedNode?.nodeType, window.Node.TEXT_NODE);

  output += '\n\n**Complete**';
  transcript.render(messages(output), shell(), strings('en'));
  assert.equal(markdown.classList.contains('is-streaming'), false);
  assert.equal(root.querySelector('.answer .md strong')?.textContent, 'Complete');
  assert.equal(markdown.textContent?.length, 80_008);
  assert.equal(markdown.textContent?.endsWith('Complete'), true);
});

test('thought logs nest under Worked for and summarize brief or timed thoughts', () => {
  const cases = [
    { endedAt: 800, label: 'Thought briefly' },
    { endedAt: 1_700, label: 'Thought 2s' },
  ];
  for (const item of cases) {
    const { window, emit } = mount();
    const messages: ViewMessage[] = [
      { id: 'user', role: 'user', text: 'Think', at: 100 },
      { id: 'thought', role: 'status', text: 'Reasoning details', at: 200, turnId: 'user', meta: { type: 'thinking' } },
      { id: 'answer', role: 'assistant', text: 'Done', at: item.endedAt, turnId: 'user', final: true },
    ];
    const turns = buildTurns(messages, false, false, [{ id: 'user', startedAt: 100, endedAt: item.endedAt, waitMs: 0, status: 'completed', intent: 'chat' }]);
    assert.equal(turns[0]?.log[0]?.type, 'thinking');
    if (turns[0]?.log[0]?.type === 'thinking') assert.equal(turns[0].log[0].durationMs, item.endedAt - 200);

    emit(shell({ timings: [{ id: 'user', startedAt: 100, endedAt: item.endedAt, waitMs: 0, status: 'completed', intent: 'chat' }] }), messages);
    click(window.document.querySelector('.log-toggle')!);
    const details = window.document.querySelector<HTMLDetailsElement>('.log .thinking')!;
    const summary = details.querySelector('summary')!;
    assert.equal(summary.classList.contains('log-toggle'), true);
    assert.equal(summary.textContent, item.label);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(details.querySelector('pre')?.textContent, 'Reasoning details');

    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    const workToggle = window.document.querySelector<HTMLButtonElement>('[data-action="toggle-log"]')!;
    click(workToggle);
    assert.equal(details.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    click(workToggle);
    assert.equal(details.open, false);
  }
});

test('file changes appear inline in the work log and keep the changed file visible after completion', () => {
  const { window, sent, emit } = mount();
  emit(shell(), [
    { id: 'user', role: 'user', text: 'Update README', at: 1 },
    { id: 'files', role: 'tool', text: 'Changed README.md', at: 2, turnId: 'user', meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', additions: 2, deletions: 1, preview: [{ kind: 'remove', line: 3, text: 'old line' }, { kind: 'add', line: 3, text: 'new line' }] }] } },
    { id: 'answer', role: 'assistant', text: 'Done', at: 3, turnId: 'user', final: true },
  ]);

  const log = window.document.querySelector<HTMLElement>('.turn .log')!;
  assert.equal(log.hidden, false);
  const badge = log.querySelector<HTMLElement>('.file-header .file-badge');
  assert.equal(badge?.textContent, 'MD');
  assert.equal(badge?.dataset.lang, 'md');
  assert.equal(log.querySelector('.file-row .file-link')?.textContent, 'README.md');
  assert.equal(log.querySelector('.file-row .stats-add')?.textContent, '+2');
  assert.equal(log.querySelector('.file-row .stats-remove')?.textContent, '−1');
  assert.equal(log.querySelector('.diff-preview-toggle'), null);
  assert.equal(log.querySelectorAll('.file-inline-diff .diff-preview-line').length, 2);
  assert.equal(log.querySelector('.diff-preview-line.remove')?.classList.contains('remove'), true);
  assert.equal(log.querySelector('.diff-preview-line.add')?.classList.contains('add'), true);
  assert.equal(log.querySelector('.diff-preview-line.remove .diff-preview-sign')?.textContent, '−');
  assert.equal(log.querySelector('.diff-preview-line.add .diff-preview-sign')?.textContent, '+');
  assert.equal(log.querySelector('.diff-preview-line.remove .diff-preview-text')?.textContent, 'old line');
  assert.equal(log.querySelector('.diff-preview-line.add .diff-preview-text')?.textContent, 'new line');
  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /\.file-row, \.shell-tool \{ display: block; width: 100%;/);
  assert.match(css, /\.file-group \{ display: flex; flex-direction: column; gap: \.45em; \}/);
  assert.match(css, /\.file-row \{[^}]*border: 1px solid var\(--vscode-widget-border, color-mix\(in srgb, var\(--vscode-foreground\)/);
  assert.match(css, /\.file-header \.file-badge \{[^}]*color-mix\(in srgb, var\(--vscode-foreground\)/);
  assert.match(css, /\.diff-preview-line\.add \{ background: var\(--vscode-diffEditor-insertedLineBackground/);
  assert.match(css, /\.diff-preview-line\.remove \{ background: var\(--vscode-diffEditor-removedLineBackground/);
  assert.match(css, /\.diff-preview-line \{[^}]*background: transparent/);
  assert.match(css, /\.diff-preview-sign\.add \{ color: var\(--vscode-gitDecoration-addedResourceForeground/);
  assert.match(css, /\.diff-preview-sign\.remove \{ color: var\(--vscode-gitDecoration-deletedResourceForeground/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.composer-card[^{]*\.file-row \{ border: 1px solid CanvasText; \}/);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*\.diff-preview-sign\.add \{ color: LinkText; \}/);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*\.diff-preview-sign\.remove \{ color: CanvasText; \}/);
  assert.match(css, /\.shell-command-line code \{[^}]*background: transparent/);
  assert.match(css, /\.shell-command-line code \{[^}]*padding: 0/);
  click(log.querySelector('.file-row .file-link')!);
  assert.equal(posted(sent, 'openFile')?.path, 'README.md');
});

test('file diff previews use the workbench file icon supplied by the host', () => {
  const { window, emit } = mount();
  const messages = (icon?: { type: 'image'; src: string } | { type: 'font'; fontCharacter: string; fontFamily: string; fontColor?: string }): ViewMessage[] => [
    { id: 'user', role: 'user', text: 'Update', at: 1 },
    { id: 'files', role: 'tool', text: 'Changed events.test.ts', at: 2, turnId: 'user', meta: { type: 'files', files: [{ path: 'events.test.ts', kind: 'update', additions: 1, deletions: 0, ...(icon ? { icon } : {}), preview: [{ kind: 'add', line: 1, text: 'next' }] }] } },
  ];
  emit(shell(), messages());
  assert.equal(window.document.querySelector('.file-header .file-badge')?.textContent, 'TS');
  emit(shell(), messages({ type: 'image', src: 'https://example.test/ts.svg' }));
  const image = window.document.querySelector<HTMLImageElement>('.file-header img.file-icon');
  assert.equal(image?.getAttribute('src'), 'https://example.test/ts.svg');
  assert.equal(image?.getAttribute('alt'), '');
  assert.equal(window.document.querySelector('.file-header .file-badge'), null);
  emit(shell(), messages({ type: 'font', fontCharacter: '\\E023', fontFamily: 'seti', fontColor: '#519aba' }));
  const font = window.document.querySelector<HTMLElement>('.file-header .file-icon.font-icon');
  assert.equal(font?.textContent, '\uE023');
  assert.equal(font?.style.fontFamily, 'seti');
  assert.match(font?.style.color ?? '', /519aba|rgb\(81,\s*154,\s*186\)/i);
});

test('long file diffs stay collapsed until the preview is expanded', () => {
  const { window, emit } = mount();
  const omitted = { kind: 'more' as const, text: '4 removed lines omitted' };
  const preview = [
    ...Array.from({ length: 6 }, (_, index) => ({ kind: 'remove' as const, line: index + 1, text: `old ${index}` })),
    omitted,
    { kind: 'add' as const, line: 1, text: 'new tail' },
    { kind: 'context' as const, line: 12, text: 'after' },
  ];
  emit(shell(), [
    { id: 'user', role: 'user', text: 'Rewrite README', at: 1 },
    { id: 'files', role: 'tool', text: 'Changed README.md', at: 2, turnId: 'user', meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', additions: 1, deletions: 10, preview }] } },
  ]);

  const card = window.document.querySelector<HTMLElement>('.file-row')!;
  assert.equal(card.querySelectorAll('.diff-preview-line').length, 7);
  assert.equal(card.querySelector('.diff-preview-line.more')?.textContent, '4 removed lines omitted');
  assert.equal(card.querySelector('.diff-preview-text')?.textContent?.includes('new tail'), false);
  const toggle = card.querySelector<HTMLButtonElement>('.diff-preview-toggle')!;
  assert.equal(toggle.textContent, 'Show more');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  click(toggle);
  const expanded = window.document.querySelector<HTMLElement>('.file-row')!;
  assert.equal(expanded.querySelector('.file-inline-diff')?.classList.contains('is-expanded'), true);
  assert.equal(expanded.querySelectorAll('.diff-preview-line').length, preview.length);
  assert.equal(expanded.querySelector('.diff-preview-line.add .diff-preview-text')?.textContent, 'new tail');
  assert.equal(expanded.querySelector('.diff-preview-toggle')?.textContent, 'Show less');
  assert.equal(expanded.querySelector('.diff-preview-toggle')?.getAttribute('aria-expanded'), 'true');
});

test('token usage is visibly rendered with cache semantics, context and unsupported state', () => {
  const { window, emit } = mount();
  emit(shell({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, totalTokens: 120, inputIncludesCache: true, contextWindow: 1000, contextTokens: 100 } }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Input 100.*Output 20.*Total 120/);
  assert.match(window.document.querySelector('.usage-panel pre')!.textContent!, /10.0%/);
  emit(shell({ backend: 'acp', usage: null }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Unsupported/);
  emit(shell({ provider: 'cursor', backend: 'cli', usage: null }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Unsupported/);
  emit(shell({ provider: 'codex', backend: 'cli', usage: null }));
  assert.match(window.document.querySelector('.usage-panel summary')!.textContent!, /Not reported/);
});

test('an error card shows the message and does not pretend the copy succeeded', () => {
  const { window, emit } = mount();
  emit(shell(), [
    { id: 'user', role: 'user', text: 'hi', at: 1 },
    { id: 'err', role: 'error', text: 'connection failed', at: 2 },
  ]);
  click(visible(window.document, '.new-chat'));
  assert.match(window.document.querySelector('.error-block')?.textContent ?? '', /connection failed/);
  assert.equal(window.document.querySelector('.error-block [data-action="retry"]')?.getAttribute('data-action'), 'retry');
});

test('chat colors follow host theme variables instead of a fixed dark or light palette', () => {
  const css = readFileSync(path.join(__dirname, '../../src/webview/styles.css'), 'utf8');
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /color:\s*var\(--vscode-foreground\)/);
  assert.match(css, /background:\s*var\(--vscode-sideBar-background\)/);
  const { window, emit } = mount();
  emit(shell());
  const body = window.document.body;
  for (const [foreground, background] of [['rgb(255, 255, 255)', 'rgb(0, 0, 0)'], ['rgb(20, 20, 20)', 'rgb(250, 250, 250)']] as const) {
    body.style.setProperty('--vscode-foreground', foreground);
    body.style.setProperty('--vscode-sideBar-background', background);
    assert.equal(body.style.getPropertyValue('--vscode-foreground'), foreground);
    assert.equal(body.style.getPropertyValue('--vscode-sideBar-background'), background);
  }
});
