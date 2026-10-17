import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { renderPending, renderPlanBody } from '../../src/webview/cards.js';
import { createDom, isButton, isElement, isInput } from '../../src/webview/dom.js';
import { fileIcon } from '../../src/webview/file-icon.js';
import { parseMarkdown, renderInline, renderMarkdown, renderStreamingText } from '../../src/webview/markdown.js';
import { Menu, ModelMenu } from '../../src/webview/popover.js';
import { countLabel, formatDuration, relativeTime, strings } from '../../src/webview/strings.js';
import { caretToken } from '../../src/webview/composer.js';
import { buildTurns } from '../../src/webview/turns.js';
import type { ViewMessage } from '../../src/protocol.js';
import type { ToolInfo } from '../../src/types.js';

function page() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  return { window, dom, host, document: window.document };
}

test('strings cover both locales, durations, and relative ages', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  assert.equal(strings('ja').submit, '送信');
  assert.equal(strings('en').submit, 'Submit');
  assert.equal(formatDuration(0), '1s');
  assert.equal(formatDuration(999), '1s');
  assert.equal(formatDuration(61_000), '1m 1s');
  const kinds: ToolInfo['kind'][] = ['read', 'edit', 'search', 'shell', 'git', 'mcp', 'subagent', 'other'];
  for (const kind of kinds) {
    assert.match(countLabel('en', kind, 1), /1|once/);
    assert.match(countLabel('en', kind, 2), /2/);
    assert.match(countLabel('ja', kind, 1), /\d|サブ|Git|MCP/);
    assert.notEqual(countLabel('ja', kind, 2), countLabel('en', kind, 2));
  }
  assert.equal(relativeTime('en', 'nope', now), '');
  assert.equal(relativeTime('ja', 'nope', now), '');
  assert.equal(relativeTime('en', '2026-10-17T12:00:00.000Z', now), 'just now');
  assert.equal(relativeTime('ja', '2026-10-17T11:59:40.000Z', now), 'たった今');
  assert.equal(relativeTime('en', '2026-10-17T11:50:00.000Z', now), '10m');
  assert.equal(relativeTime('ja', '2026-10-17T11:50:00.000Z', now), '10分前');
  assert.equal(relativeTime('en', '2026-10-17T10:00:00.000Z', now), '2h');
  assert.equal(relativeTime('ja', '2026-10-17T10:00:00.000Z', now), '2時間前');
  assert.equal(relativeTime('en', '2026-10-15T12:00:00.000Z', now), '2d');
  assert.equal(relativeTime('ja', '2026-10-15T12:00:00.000Z', now), '2日前');
  const older = '2026-10-01T12:00:00.000Z';
  assert.equal(relativeTime('en', older, now), new Date(older).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  assert.equal(relativeTime('ja', older, now), new Date(older).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }));
});

test('caretToken distinguishes the start, the middle of a token, and plain text', () => {
  assert.equal(caretToken('@readme', 0), undefined);
  assert.deepEqual(caretToken('@readme extra', 4), { kind: 'file', query: 'rea', start: 0 });
  assert.deepEqual(caretToken('see @readme', 11), { kind: 'file', query: 'readme', start: 4 });
  assert.equal(caretToken('a@readme', 8), undefined);
  assert.equal(caretToken('hello', 5), undefined);
  assert.equal(caretToken('hello /run', 10), undefined);
  assert.deepEqual(caretToken('hello\n/run', 10), { kind: 'slash', query: 'run', start: 6 });
  assert.deepEqual(caretToken('/run', 4), { kind: 'slash', query: 'run', start: 0 });
});

test('dom predicates reject non-elements and icons keep modifiers', () => {
  const { document, dom } = page();
  const div = document.createElement('div');
  const input = document.createElement('input');
  assert.equal(isElement(null), false);
  assert.equal(isElement('x'), false);
  assert.equal(isElement(div), true);
  assert.equal(isButton(div), false);
  assert.equal(isButton(input), false);
  assert.equal(isButton(null), false);
  assert.equal(isInput(div), false);
  assert.equal(isInput(input), true);
  const bare = dom.el('span');
  assert.equal(bare.className, '');
  assert.equal(bare.textContent, '');
  const plain = dom.button('ghost', 'Label');
  assert.equal(plain.querySelector('.codicon'), null);
  assert.equal(plain.querySelector('.btn-label')?.textContent, 'Label');
  const icon = dom.icon('loading~spin');
  assert.match(icon.className, /codicon-loading/);
  assert.match(icon.className, /codicon-modifier-spin/);
});

test('file icons fall back, dedupe a font, and recover after a failed load', async () => {
  const { document, dom } = page();
  assert.equal(fileIcon(dom, { name: 'Makefile' }).textContent, 'MA');
  assert.equal(fileIcon(dom, { name: 'note.ts', icon: { type: 'badge', badge: 'OK' } }).textContent, 'OK');
  assert.equal(fileIcon(dom, { name: 'note.ts', icon: { type: 'image', src: '' } }).className, 'file-badge');
  const raw = fileIcon(dom, { name: 'note.ts', icon: { type: 'font', fontCharacter: '\uE023' } });
  assert.equal(raw.textContent, '\uE023');
  assert.equal(raw.style.fontFamily, '');

  const previous = globalThis.FontFace;
  const added: unknown[] = [];
  let constructed = 0;
  class FakeFontFace {
    constructor(public family: string, public source: string) { constructed += 1; }
    load(): Promise<FakeFontFace> { return Promise.resolve(this); }
  }
  document.fonts = { add(face: unknown) { added.push(face); } } as FontFaceSet;
  Object.assign(globalThis, { FontFace: FakeFontFace });
  try {
    const first = fileIcon(dom, { name: 'a.ts', icon: { type: 'font', fontCharacter: '\\E023', fontFamily: 'seti-a', src: 'seti-a.woff' } });
    const second = fileIcon(dom, { name: 'b.ts', icon: { type: 'font', fontCharacter: '\\E023', fontFamily: 'seti-a', src: 'seti-a.woff' } });
    assert.equal(first.textContent, '\uE023');
    assert.equal(second.style.fontFamily, 'seti-a');
    assert.equal(constructed, 1);
    await Promise.resolve();
    assert.equal(added.length, 1);

    class RejectFontFace {
      constructor(public family: string, public source: string) { constructed += 1; }
      load(): Promise<never> { return Promise.reject(new Error('missing')); }
    }
    Object.assign(globalThis, { FontFace: RejectFontFace });
    fileIcon(dom, { name: 'c.ts', icon: { type: 'font', fontCharacter: 'A', fontFamily: 'seti-b', src: 'seti-b.woff' } });
    const beforeRetry = constructed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    fileIcon(dom, { name: 'c.ts', icon: { type: 'font', fontCharacter: 'A', fontFamily: 'seti-b', src: 'seti-b.woff' } });
    assert.equal(constructed, beforeRetry + 1);

    Reflect.deleteProperty(globalThis, 'FontFace');
    const withoutFace = fileIcon(dom, { name: 'd.ts', icon: { type: 'font', fontCharacter: 'B', fontFamily: 'seti-c', src: 'seti-c.woff' } });
    assert.equal(withoutFace.textContent, 'B');
    assert.equal(constructed, beforeRetry + 1);

    Object.assign(globalThis, { FontFace: FakeFontFace });
    const bareDocument = new Window().document;
    const bare = createDom(bareDocument);
    assert.equal(fileIcon(bare, { name: 'e.ts', icon: { type: 'font', fontCharacter: 'C', fontFamily: 'seti-d', src: 'seti-d.woff' } }).textContent, 'C');
    assert.equal(constructed, beforeRetry + 1);
  } finally {
    if (previous) Object.assign(globalThis, { FontFace: previous });
    else Reflect.deleteProperty(globalThis, 'FontFace');
  }
});

test('markdown renders blocks, highlighting, links, and streaming snapshots', () => {
  const { dom, host } = page();
  const source = [
    '# Title',
    '## Section',
    '### Smaller',
    '#### Capped',
    '',
    'Paragraph with `code`, **bold**, and *em*.',
    'Keeps going',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '> still',
    '',
    '---',
    '',
    '| Name | Note |',
    '| --- | --- |',
    '| `a` | [app](src/app.ts:2:3) |',
    '| plain | [bad](foo/%ZZ.txt) |',
    '',
    '```ts',
    'const value = "hi"; // note',
    '/* block */',
    'const count = 3.5;',
    '```',
    '',
    '```py',
    '# comment',
    'def run():',
    '    return None',
    '```',
    '',
    '```sh',
    'echo hi',
    '```',
    '',
    '```go',
    'func main() {}',
    '```',
    '',
    '```rs',
    'fn main() {}',
    '```',
    '',
    '```css',
    'body { color: red; }',
    '```',
    '',
    '```json',
    '{ "a": 1 }',
    '```',
    '',
    '```unknown',
    'plain',
    '```',
    '',
    '```ts',
    'const open = true',
  ].join('\n');
  const parsed = parseMarkdown('# Direct parser\n\n- first\n- second');
  assert.deepEqual(parsed.slice(0, 2), [
    { type: 'heading', level: 1, text: 'Direct parser' },
    { type: 'list', ordered: false, items: ['first', 'second'] },
  ]);
  const inline = dom.el('span');
  renderInline(inline, 'inline `code` and **bold**', dom);
  assert.equal(inline.querySelector('code')?.textContent, 'code');
  assert.equal(inline.querySelector('strong')?.textContent, 'bold');
  renderMarkdown(host, source, dom);
  assert.equal(host.querySelector('h2')?.textContent, 'Title');
  assert.equal(host.querySelector('h3')?.textContent, 'Section');
  assert.equal(host.querySelectorAll('h4').length, 2);
  assert.equal(host.querySelector('ul li')?.textContent, 'one');
  assert.equal(host.querySelector('ol li')?.textContent, 'first');
  assert.match(host.querySelector('blockquote')?.textContent ?? '', /quoted/);
  assert.equal(host.querySelectorAll('hr').length, 1);
  assert.equal(host.querySelector('table td code')?.textContent, 'a');
  assert.equal(host.querySelector('table .file-link')?.getAttribute('data-path'), 'src/app.ts');
  assert.equal(host.querySelectorAll('table .file-link')[1]?.getAttribute('data-path'), 'foo/%ZZ.txt');
  assert.equal(host.querySelector('[data-lang="ts"] .tok-kw')?.textContent, 'const');
  assert.match(host.querySelector('[data-lang="ts"] .tok-str')?.textContent ?? '', /hi/);
  assert.equal(host.querySelector('[data-lang="ts"] .tok-cmt')?.textContent?.startsWith('//'), true);
  assert.equal(host.querySelector('[data-lang="ts"] .tok-num')?.textContent, '3.5');
  assert.equal(host.querySelector('[data-lang="py"] .tok-kw')?.textContent, 'def');
  assert.equal(host.querySelector('[data-lang="sh"] .tok-kw')?.textContent, 'echo');
  assert.equal(host.querySelector('[data-lang="go"] .tok-kw')?.textContent, 'func');
  assert.equal(host.querySelector('[data-lang="rs"] .tok-kw')?.textContent, 'fn');
  assert.equal(host.querySelector('[data-lang="css"] .tok-kw'), null);
  assert.equal(host.querySelector('[data-lang="json"] .tok-kw'), null);
  assert.equal(host.querySelector('[data-lang="unknown"] .tok-kw'), null);
  const open = [...host.querySelectorAll('.code-block')].at(-1);
  assert.equal(open?.querySelector('.tok-kw'), null);
  assert.match(open?.textContent ?? '', /const open = true/);

  const long = dom.el('div');
  host.append(long);
  renderMarkdown(long, '```js\n' + 'const x = 1;\n'.repeat(2000) + '```', dom);
  assert.equal(long.querySelector('.tok-kw'), null);
  assert.match(long.textContent ?? '', /const x = 1;/);

  renderStreamingText(host, 'Hello');
  const node = host.firstChild;
  assert.equal(host.classList.contains('is-streaming'), true);
  renderStreamingText(host, 'Hello');
  assert.equal(host.firstChild, node);
  renderStreamingText(host, 'Hello!');
  assert.equal(host.textContent, 'Hello!');
  renderStreamingText(host, 'Reset');
  assert.equal(host.textContent, 'Reset');
  renderMarkdown(host, 'Reset **done**', dom);
  assert.equal(host.classList.contains('is-streaming'), false);
  assert.equal(host.querySelector('strong')?.textContent, 'done');
});

test('turns merge files, thoughts, tools, and answers', () => {
  const file = (path: string, extra: Record<string, unknown> = {}) => ({ path, kind: 'update', ...extra });
  const messages: ViewMessage[] = [
    { id: 'early', role: 'assistant', text: 'before', at: 1 },
    { id: 'user', role: 'user', text: 'go', at: 2, canRewind: false, rewindReason: 'missing' },
    { id: 'plan', role: 'status', text: 'plan', meta: { type: 'plan' } },
    { id: 'terms', role: 'status', text: 'terms', meta: { type: 'terminals' } },
    { id: 'think1', role: 'status', text: 'Hello', at: 3, meta: { type: 'thinking' } },
    { id: 'think2', role: 'status', text: 'Hello world', meta: { type: 'thinking' } },
    { id: 'think3', role: 'status', text: 'world', meta: { type: 'thinking' } },
    { id: 'think4', role: 'status', text: 'more', meta: { type: 'thinking' } },
    { id: 'after-think', role: 'status', text: 'next', at: 9 },
    { id: 'blank-tool', role: 'tool', text: '   ' },
    { id: 'git', role: 'tool', text: 'failed: git status\noutput' },
    { id: 'named', role: 'tool', text: 'ran', tool: { name: 'Read', kind: 'read', status: 'completed', target: 'src/app.ts', line: 4, exitCode: 0 } },
    { id: 'files-a', role: 'tool', text: 'files', meta: { type: 'files', files: [file('dir/app.ts', { additions: 2, deletions: 1, preview: [{ kind: 'add', text: 'next' }], icon: { type: 'badge', badge: 'TS' } }), file('dir/', {})] } },
    { id: 'files-b', role: 'tool', text: 'files', meta: { type: 'files', files: [file('dir/app.ts', {}), file('other.ts', { additions: 1 })] } },
    { id: 'todo', role: 'status', text: 'todos', meta: { type: 'todo', todos: [{ content: 'one', status: 'done' }] } },
    { id: 'empty-todo', role: 'status', text: 'none', meta: { type: 'todo', todos: [] } },
    { id: 'image', role: 'status', text: 'img', meta: { type: 'image', imagePath: 'shot.png' } },
    { id: 'task', role: 'status', text: 'fallback', meta: { type: 'task', task: '' } },
    { id: 'note', role: 'status', text: ' status ' },
    { id: 'blank-status', role: 'status', text: '  ' },
    { id: 'sub', role: 'status', text: 'sub', meta: { type: 'subagent', subagent: { id: 's', name: 'explore', status: 'completed', background: 'unknown' } } },
    { id: 'progress', role: 'assistant', text: 'Working' },
    { id: 'progress-2', role: 'assistant', text: 'Still' },
    { id: 'final', role: 'assistant', text: 'Done', final: true, at: 9 },
    { id: 'err', role: 'error', text: 'boom', at: 1 },
  ];
  const [orphan, turn] = buildTurns(messages, false, false, [{ id: 'user', startedAt: 20, endedAt: 1, waitMs: 0, status: 'completed', intent: 'chat' }]);
  assert.equal(orphan?.id, 'pre-early');
  assert.equal(orphan?.user, undefined);
  assert.equal(orphan?.answer?.text, 'before');
  assert.equal(orphan?.done, true);
  assert.equal(turn?.user?.rewindReason, 'missing');
  assert.equal(turn?.startedAt, 20);
  assert.equal(turn?.endedAt, 1);
  const thinking = turn?.log.find((segment) => segment.type === 'thinking');
  assert.equal(thinking?.type === 'thinking' ? thinking.text : '', 'Hello world\nmore');
  assert.equal(thinking?.type === 'thinking' ? thinking.durationMs : undefined, 6);
  const tools = turn?.log.find((segment) => segment.type === 'tools');
  assert.equal(tools?.type === 'tools' ? tools.tools[0]?.kind : '', 'git');
  assert.equal(tools?.type === 'tools' ? tools.tools[0]?.status : '', 'error');
  assert.equal(tools?.type === 'tools' ? tools.tools[1]?.exitCode : undefined, 0);
  const files = turn?.log.find((segment) => segment.type === 'files');
  if (files?.type === 'files') {
    assert.equal(files.files[0]?.name, 'app.ts');
    assert.equal(files.files[0]?.additions, 2);
    assert.equal(files.files[0]?.deletions, 1);
    assert.equal(files.files[0]?.preview?.[0]?.text, 'next');
    assert.equal(files.files[1]?.name, 'dir/');
    assert.equal(files.files[2]?.name, 'other.ts');
  } else assert.fail('files');
  assert.equal(turn?.log.some((segment) => segment.type === 'todo'), true);
  assert.equal(turn?.log.some((segment) => segment.type === 'note' && segment.text === 'shot.png'), true);
  assert.equal(turn?.log.some((segment) => segment.type === 'note' && segment.text === 'fallback'), true);
  assert.equal(turn?.answer?.text, 'Working\n\nStill\n\nDone');
  assert.equal(turn?.log.some((segment) => segment.type === 'text'), false);
  assert.equal(turn?.errors[0]?.text, 'boom');
  assert.equal(turn?.done, true);

  const running = buildTurns([
    { id: 'user', role: 'user', text: 'go', at: 5 },
    { id: 'think', role: 'status', text: 'hmm', at: 4, meta: { type: 'thinking' } },
  ], true, false);
  const live = running[0]?.log[0];
  assert.equal(live?.type === 'thinking' ? live.durationMs : 0, undefined);
  assert.equal(running[0]?.done, false);
  const settled = buildTurns([
    { id: 'user', role: 'user', text: 'go', at: 5 },
    { id: 'think', role: 'status', text: 'hmm', at: 6, meta: { type: 'thinking' } },
    { id: 'only-tool', role: 'tool', text: 'ran', tool: { name: 'search', kind: 'search', status: 'completed' } },
  ], false, true);
  assert.equal(settled[0]?.answer, undefined);
  assert.equal(settled[0]?.done, false);
  const closed = settled[0]?.log.find((segment) => segment.type === 'thinking');
  assert.equal(closed?.type === 'thinking' ? closed.durationMs : undefined, undefined);
});

test('plan and question cards post only their own decisions', () => {
  const { dom, host } = page();
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const post = (message: { type: string; [key: string]: unknown }) => { sent.push(message); };
  const copy = strings('en');
  const base = {
    provider: 'codex' as const, providerLabel: 'Codex', cwd: '/workspace', busy: false, presence: 'idle' as const,
    statusText: 'Ready', sessionTitle: 'New', modelLabel: 'gpt', effortLabel: null, modelSettings: 'new-session' as const,
    accessLabel: 'Workspace write', risky: false, banner: null, backendLabel: 'SDK', folderName: 'workspace',
    folders: [], modes: [], mode: 'agent', showMode: true, sandboxChoices: [], sandbox: 'workspace-write',
    approvalChoices: [], approval: 'never', showApproval: false, webSearchChoices: [], webSearch: '', showWebSearch: false,
    network: false, showNetwork: false, backendChoices: [], backend: 'sdk' as const, additionalDirectories: [],
    autoApprove: false, steer: false, interactiveApproval: false, conversationId: 'front', queue: [], changes: [],
    planView: null, timings: [], subagents: [], terminals: [], additions: 0, deletions: 0, sessions: [], usage: null,
    permission: null, plan: null, question: null, activeFile: null, locale: 'en' as const, providers: [],
  };
  renderPending(host, { ...base, plan: { token: 'plan-token', request: { id: 'plan-1', name: '', overview: 'Over', plan: 'Body', todos: [] } } }, dom, copy, post);
  assert.match(host.textContent ?? '', /Plan/);
  const buttons = [...host.querySelectorAll('button')];
  buttons.find((button) => button.textContent === 'Approve')?.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
  buttons.find((button) => button.textContent === 'Reject')?.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
  assert.equal(sent[0]?.decision, 'accepted');
  assert.equal(sent[1]?.decision, 'rejected');
  assert.equal(sent.every((message) => message.type === 'resolvePlan' && message.token === 'plan-token'), true);
  renderPlanBody(host, (parent, text) => renderMarkdown(parent, text, dom), 'Over', '**Body**');
  assert.match(host.querySelector('.md')?.textContent ?? '', /Over/);
  assert.equal(host.querySelector('.md strong')?.textContent, 'Body');

  renderPending(host, { ...base, question: { token: 'q', request: { id: 'ask', title: '', questions: [
    { id: 'free', prompt: 'Type', options: [] },
    { id: 'pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
  ] } } }, dom, copy, post);
  assert.match(host.textContent ?? '', /Question/);
  const text = host.querySelector('input[type="text"]') as HTMLInputElement;
  text.value = '   ';
  host.querySelector('button')?.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(sent.at(-1)?.answers, {});
  text.value = ' typed ';
  host.querySelector('button')?.dispatchEvent(new host.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(sent.at(-1)?.answers, { free: ['typed'] });
  assert.equal(sent.at(-1)?.type, 'resolveQuestion');
  assert.notEqual(sent.at(-1)?.type, 'resolvePlan');

  const bare = dom.el('div');
  let called = false;
  renderPlanBody(bare, () => { called = true; }, 'Over', 'Body');
  assert.equal(called, false);
  const body = dom.el('div', 'md');
  bare.append(body);
  renderPlanBody(bare, (parent, text) => { parent.textContent = text; }, undefined, 'Only');
  assert.equal(body.textContent, 'Only');
});

test('menus close from the keyboard and from outside clicks, and nested search can come up empty', () => {
  const { window, dom, host } = page();
  const trigger = dom.button('mode', 'Mode');
  host.append(trigger);
  const menu = new Menu(dom, host);
  const selected: string[] = [];
  window.innerHeight = 0;
  window.innerWidth = 800;
  menu.open(trigger, [
      { id: 'note', label: 'Note', description: 'why' },
      { id: 'agent', label: 'Agent', icon: 'infinity', checked: true, description: 'Default', onSelect: () => selected.push('agent') },
      { id: 'plan', label: 'Plan', icon: 'list-flat', onSelect: () => selected.push('plan') },
      { id: 'off', label: 'Off', disabled: true, onSelect: () => selected.push('off') },
    ]);
    assert.equal(menu.element.querySelector('.menu-note')?.getAttribute('title'), 'why');
    assert.equal(menu.element.querySelector('[data-id="agent"] .menu-glyph')?.textContent, '∞');
    assert.match(menu.element.querySelector('[data-id="plan"] .codicon')?.className ?? '', /list-flat/);
    assert.equal(menu.element.querySelector('[data-id="agent"]')?.getAttribute('aria-checked'), 'true');
    assert.equal(menu.element.style.top, 'auto');
    assert.equal(menu.element.style.bottom, '6px');
    const down = new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    menu.element.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    menu.element.dispatchEvent(space);
    assert.equal(space.defaultPrevented, true);
    assert.deepEqual(selected, ['plan']);
    menu.open(trigger, [{ id: 'agent', label: 'Agent', onSelect: () => selected.push('again') }]);
    menu.element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(menu.isOpen, true);
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(menu.isOpen, true);
    window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(menu.isOpen, false);
    menu.open(trigger, [{ id: 'agent', label: 'Agent', onSelect: () => selected.push('enter') }]);
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(selected.at(-1), 'enter');
    menu.open(trigger, [{ id: 'agent', label: 'Agent', onSelect: () => selected.push('tab') }]);
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    menu.element.dispatchEvent(tab);
    assert.equal(menu.isOpen, false);
    assert.equal(tab.defaultPrevented, false);
    assert.equal(selected.includes('tab'), false);
    menu.open(trigger, [{ id: 'agent', label: 'Agent', onSelect: () => selected.push('esc') }]);
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(menu.isOpen, false);
    menu.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(selected.includes('esc'), false);
    menu.close(true);

  const model = new ModelMenu(dom, host);
  const picked: string[] = [];
  window.innerWidth = 800;
  window.innerHeight = 0;
  model.open(trigger, {
      items: [
        { id: 'effort', label: 'Effort', valueLabel: 'High', description: 'Reasoning', submenu: () => ({ backLabel: 'Back', items: [
          { id: 'low', label: 'Low', checked: false, onSelect: () => picked.push('low') },
          { id: 'high', label: 'High', checked: true, description: 'Slow', onSelect: () => picked.push('high') },
        ] }) },
        { id: 'fast', label: 'Fast', toggle: true, checked: true, onSelect: () => picked.push('fast') },
        { id: 'off', label: 'Off', disabled: true, onSelect: () => picked.push('off') },
        { id: 'note', label: 'Loading', description: 'wait' },
        { id: 'after', label: 'After', separatorBefore: true, onSelect: () => picked.push('after') },
        { id: 'pin', label: 'Refresh', pinned: true, onSelect: () => picked.push('pin') },
      ],
    });
    assert.equal(model.element.style.top, '8px');
    assert.equal(model.element.querySelector('[data-id="fast"]')?.getAttribute('role'), 'menuitemcheckbox');
    assert.ok(model.element.querySelector('.menu-sep'));
    model.element.querySelector<HTMLButtonElement>('[data-id="after"]')?.click();
    assert.equal(model.isOpen, false);
    assert.deepEqual(picked, ['after']);
    model.open(trigger, { items: [{ id: 'pin', label: 'Refresh', pinned: true, onSelect: () => picked.push('pin') }, { id: 'effort', label: 'Effort', submenu: () => ({ items: [{ id: 'low', label: 'Low', onSelect: () => picked.push('low') }] }) }] });
    model.element.querySelector<HTMLButtonElement>('[data-id="pin"]')?.click();
    assert.equal(model.isOpen, true);
    model.element.querySelector<HTMLButtonElement>('[data-id="effort"]')?.click();
    const child = host.querySelector('.submenu') as HTMLElement;
    if (!child.hidden) {
      assert.equal(child.style.left, '4px');
      child.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
      assert.equal(model.isOpen, true);
      child.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    } else {
      assert.ok(model.element.querySelector('[data-id="back"]'));
      model.element.querySelector<HTMLButtonElement>('[data-id="back"]')?.click();
    }
    assert.equal(host.querySelector('[data-id="low"]'), null);
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    model.open(trigger, {
      search: { placeholder: 'Search models', empty: 'No matching models' },
      backLabel: 'Back',
      items: [
        { id: 'alpha', label: 'Alpha', description: 'first', searchText: 'aaa', checked: true, onSelect: () => picked.push('alpha') },
        { id: 'beta', label: 'Beta', onSelect: () => picked.push('beta') },
        { id: 'pin', label: 'Refresh', pinned: true, onSelect: () => picked.push('refresh') },
      ],
    });
    const search = model.element.querySelector('input') as HTMLInputElement;
    search.value = 'missing';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(model.element.textContent ?? '', /No matching models/);
    assert.ok(model.element.querySelector('[data-id="pin"]'));
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    assert.equal(model.isOpen, true);
    search.value = 'ALP';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(picked.at(-1), 'alpha');
    assert.equal(model.isOpen, false);
    model.open(trigger, { items: [{ id: 'effort', label: 'Effort', submenu: () => ({ backLabel: 'Back', items: [{ id: 'low', label: 'Low', onSelect: () => picked.push('low') }] }) }] });
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    model.element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(model.isOpen, true);
    const modelTab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    model.element.dispatchEvent(modelTab);
    assert.equal(model.isOpen, false);
    model.close(false);
    model.replace({ items: [{ id: 'late', label: 'Late' }] });
    assert.equal(model.element.querySelector('[data-id="late"]'), null);

  window.innerWidth = 300;
  model.open(trigger, { items: [{ id: 'effort', label: 'Effort', submenu: () => ({ backLabel: 'Back', search: { placeholder: 'Find', empty: 'None' }, items: [{ id: 'low', label: 'Low', onSelect: () => picked.push('drilled') }] }) }] });
    model.element.querySelector<HTMLButtonElement>('[data-id="effort"]')?.click();
    assert.ok(model.element.querySelector('[data-id="back"]'));
    assert.equal(host.querySelector('.submenu')?.hidden, true);
    const drillSearch = model.element.querySelector('input') as HTMLInputElement;
    drillSearch.value = 'nope';
    drillSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(model.element.textContent ?? '', /None/);
    model.element.querySelector<HTMLButtonElement>('[data-id="back"]')?.click();
    assert.equal(model.element.querySelector('[data-id="effort"]')?.isConnected, true);
    window.document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
    assert.equal(model.isOpen, false);
});
