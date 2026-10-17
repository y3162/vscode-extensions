import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { StateMessage } from '../../src/protocol.js';
import type { AgentsSidebar } from '../../src/sidebar.js';
import { ColorThemeKind, commands, ConfigurationTarget, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, settle, waitFor, type Harness, type TestView } from '../support/vscode-harness.js';

async function close(harness: Harness, historyMode?: { dir: string; mode: number }): Promise<void> {
  if (historyMode) chmodSync(historyMode.dir, historyMode.mode);
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

function states(view: TestView): StateMessage[] {
  return view.messages.filter((message) => message.type === 'state') as unknown as StateMessage[];
}

async function ready(sidebar: AgentsSidebar, view: TestView): Promise<void> {
  sidebar.resolveWebviewView(view as never);
  await sidebar.handleMessage({ type: 'ready' }, view as never);
}

function writeFakeCodex(dir: string): string {
  const file = path.join(dir, 'fake-codex.mjs');
  writeFileSync(file, [
    `#!${process.execPath}`,
    "import readline from 'node:readline';",
    'const rl = readline.createInterface({ input: process.stdin });',
    "rl.on('line', (line) => {",
    '  let msg;',
    '  try { msg = JSON.parse(line); } catch { return; }',
    '  if (msg.id === undefined) return;',
    "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');",
    "  else if (msg.method === 'model/list') {",
    '    const data = [{ model: "gpt-test", displayName: "GPT Test", isDefault: true, description: "fixture", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }, { reasoningEffort: "high", description: "high" }], defaultReasoningEffort: "low" }];',
    "    process.stdout.write(JSON.stringify({ id: msg.id, result: { data } }) + '\\n');",
    "  } else process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unsupported' } }) + '\\n');",
    '});',
    '',
  ].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

test('a missing or untrusted workspace is rejected before any session starts', async () => {
  resetVscode();
  const harness = openSidebar(undefined, { folders: false });
  const view = createView();
  const before = readdirSync(harness.workspacePath);
  try {
    await ready(harness.sidebar, view);
    await assert.rejects(() => harness.sidebar.insertContext('file'), /作業対象のフォルダをVS Codeで開いてください/);
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: '', prompt: 'hello' }), /作業対象のフォルダをVS Codeで開いてください/);
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'hello' }), /見つかりません/);
    workspace.workspaceFolders = [{ name: 'workspace', uri: Uri.file(harness.workspacePath), index: 0 }];
    workspace.isTrusted = false;
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'hello' }), /信頼してから実行してください/);
    assert.deepEqual(readdirSync(harness.workspacePath), before);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
  } finally {
    await close(harness);
  }
});

test('rewind journals restore an interrupted file, leave a matching session untouched, and keep a journal that no longer matches', async () => {
  resetVscode();
  const harness = openSidebar(({ context, workspacePath, root }) => {
    const history = path.join(context.storageUri.fsPath, 'history', 'v1');
    const journals = path.join(history, 'rewind-journals');
    mkdirSync(journals, { recursive: true });
    const cwd = realpathSync(workspacePath);
    writeFileSync(path.join(workspacePath, 'keep.txt'), 'untouched');
    writeFileSync(path.join(workspacePath, 'restore.txt'), 'before');
    writeFileSync(path.join(workspacePath, 'tamper.txt'), 'tampered');
    const mode = statSync(path.join(workspacePath, 'restore.txt')).mode & 0o777;
    const conversationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const savedConversation = (id: string, sessionId: string) => ({
      version: 1, id, sessionId, updatedAt: '2026-01-01T00:00:00.000Z',
      controls: { mode: 'agent', sandbox: 'workspace-write', approval: 'never', backend: 'sdk', network: false, webSearch: '', additionalDirectories: [] },
      state: {
        selection: { provider: 'codex', cwd: workspacePath, model: '' }, busy: false,
        messages: [{ id: 'user-1', role: 'user', text: 'saved' }], queue: [], status: 'idle', usage: null,
        changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
        plan: { phase: 'idle', revisions: [] }, turns: [], subagents: [], terminals: [],
      },
    });
    writeFileSync(path.join(history, `${conversationId}.json`), JSON.stringify(savedConversation(conversationId, 'branch-keep')));
    const recoverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    writeFileSync(path.join(history, `${recoverId}.json`), JSON.stringify(savedConversation(recoverId, 'original-session')));
    const mismatchId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    writeFileSync(path.join(history, `${mismatchId}.json`), JSON.stringify(savedConversation(mismatchId, 'original-session')));
    const outsidePath = path.join(root, 'outside.txt');
    writeFileSync(outsidePath, 'outside-after');
    const outsideMode = statSync(outsidePath).mode & 0o777;
    writeFileSync(path.join(history, 'cccccccc-cccc-cccc-cccc-cccccccccccc.json'), '{');
    const journal = (name: string, conversation: string, branchId: string, file: string, before: string, expected: string, backup: string, root = cwd, fileMode = mode) => {
      writeFileSync(path.join(journals, name), JSON.stringify({
        version: 1, conversationId: conversation, branchId, cwd: root,
        files: [{
          path: file, beforeText: before, beforeMode: fileMode, expectedText: expected, expectedMode: fileMode,
          backupText: backup, backupMode: fileMode, tempPath: `.ai-agents-rewind-${randomUUID()}.tmp`,
        }],
      }));
    };
    journal('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.json', conversationId, 'branch-keep', 'keep.txt', 'other', 'other', 'other');
    journal('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1.json', recoverId, 'other', 'restore.txt', 'before', 'after', 'after');
    journal('dddddddd-dddd-dddd-dddd-dddddddddddd.json', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'other', 'tamper.txt', 'before', 'after', 'after');
    journal('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1.json', mismatchId, 'other', 'outside.txt', 'outside-before', 'outside-after', 'outside-before', realpathSync(root), outsideMode);
    writeFileSync(path.join(journals, 'bad.json'), '{"version":1}');
    writeFileSync(path.join(journals, 'zzzz.json'), '{"ignored":true}');
  });
  try {
    await harness.sidebar.flushHistory();
    await settle();
    assert.equal(readFileSync(path.join(harness.workspacePath, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(readFileSync(path.join(harness.workspacePath, 'restore.txt'), 'utf8'), 'after');
    assert.equal(readFileSync(path.join(harness.workspacePath, 'tamper.txt'), 'utf8'), 'tampered');
    assert.equal(readFileSync(path.join(harness.root, 'outside.txt'), 'utf8'), 'outside-after');
    const journals = path.join(harness.context.storageUri.fsPath, 'history', 'v1', 'rewind-journals');
    assert.equal(existsSync(path.join(journals, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.json')), false);
    assert.equal(existsSync(path.join(journals, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1.json')), false);
    assert.equal(existsSync(path.join(journals, 'dddddddd-dddd-dddd-dddd-dddddddddddd.json')), true);
    assert.equal(existsSync(path.join(journals, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1.json')), true);
    assert.equal(existsSync(path.join(journals, 'bad.json')), true);
    assert.equal(existsSync(path.join(journals, 'zzzz.json')), true);
    assert.equal(existsSync(path.join(harness.context.storageUri.fsPath, 'history', 'v1', 'cccccccc-cccc-cccc-cccc-cccccccccccc.json')), true);
    assert.equal(readdirSync(harness.workspacePath).some((name) => name.includes('ai-agents-rewind')), false);
    const notes = harness.sidebar.controller.snapshot().messages.map((message) => message.text).join('\n');
    assert.match(notes, /履歴を読み込めませんでした/);
    assert.match(notes, /巻き戻し中断から自動復旧できませんでした/);
    assert.match(notes, /dddddddd-dddd-dddd-dddd-dddddddddddd\.json/);
    assert.match(notes, /eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1\.json/);
    assert.match(notes, /bad\.json/);
  } finally {
    await close(harness);
  }
});

test('history save failure is reported and does not replace the previous snapshot', async () => {
  resetVscode();
  const harness = openSidebar();
  const dir = path.join(harness.context.storageUri.fsPath, 'history', 'v1');
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    harness.sidebar.controller.notify('first snapshot');
    await harness.sidebar.flushHistory();
    const saved = readdirSync(dir).find((name) => name.endsWith('.json'));
    assert.ok(saved);
    const file = path.join(dir, saved);
    assert.match(readFileSync(file, 'utf8'), /first snapshot/);
    chmodSync(dir, 0o555);
    harness.sidebar.controller.notify('second snapshot');
    await assert.rejects(() => harness.sidebar.flushHistory());
    assert.ok(harness.output.lines.some((line) => line.startsWith('History save failed:')));
    assert.ok(view.messages.some((message) => message.type === 'error' && String(message.text).includes('表示履歴を保存できませんでした')));
    chmodSync(dir, 0o755);
    assert.match(readFileSync(file, 'utf8'), /first snapshot/);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /second snapshot/);
  } finally {
    await close(harness, { dir, mode: 0o755 });
  }
});

test('clearing local history honors cancel and deletes every saved snapshot when confirmed', async () => {
  resetVscode();
  const harness = openSidebar(({ context }) => {
    void context.workspaceState.update('ai-agents.plans', { abc: { phase: 'idle', revisions: [] } });
  });
  const dir = path.join(harness.context.storageUri.fsPath, 'history', 'v1');
  try {
    harness.sidebar.controller.notify('keep me');
    await harness.sidebar.flushHistory();
    assert.ok(readdirSync(dir).some((name) => name.endsWith('.json')));
    await commands.handlers.get('ai-agents.clearLocalHistory')!();
    assert.ok(readdirSync(dir).some((name) => name.endsWith('.json')));
    assert.deepEqual(harness.context.workspaceState.get('ai-agents.plans'), { abc: { phase: 'idle', revisions: [] } });
    window.warningQueue.push({ value: 'すべて' });
    await commands.handlers.get('ai-agents.clearLocalHistory')!();
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.json')), false);
    assert.deepEqual(harness.context.workspaceState.get('ai-agents.plans'), {});
    assert.match(window.warningMessages.at(-1) ?? '', /ローカル表示履歴/);
  } finally {
    await close(harness);
  }
});

test('disabled history does not write a snapshot', async () => {
  resetVscode();
  workspace.configuration['ai-agents']!['history.enabled'] = false;
  const harness = openSidebar();
  try {
    harness.sidebar.controller.notify('do not save');
    await harness.sidebar.flushHistory();
    const dir = path.join(harness.context.storageUri.fsPath, 'history', 'v1');
    assert.equal(existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.json')), false);
  } finally {
    await close(harness);
  }
});

test('webview messages drive the sidebar without starting an agent session', async () => {
  resetVscode();
  const harness = openSidebar();
  const { sidebar, workspacePath, context, output } = harness;
  const view = createView();
  try {
    writeFileSync(path.join(workspacePath, 'AGENTS.md'), '# agents');
    writeFileSync(path.join(workspacePath, 'frozen.txt'), 'frozen');
    await ready(sidebar, view);
    assert.match(view.webview.html, /lang="en"/);
    assert.match(view.webview.html, /script-src 'nonce-/);
    assert.match(view.webview.html, /vscode-webview:\/\/test/);
    assert.equal(sidebar.isReady(), true);
    assert.equal(states(view).at(-1)?.shell.conversationId, 'front');
    assert.equal(states(view).at(-1)?.full, true);

    const beforeUnknown = view.messages.length;
    await sidebar.handleMessage(null);
    await sidebar.handleMessage({});
    await sidebar.handleMessage({ type: 'ready', conversationId: 'missing' });
    await sidebar.handleMessage({ type: 'not-a-command' });
    assert.equal(view.messages.length, beforeUnknown);

    sidebar.controller.notify('background');
    await sidebar.newChat();
    const front = states(view).at(-1)?.shell.conversationId;
    assert.notEqual(front, 'front');
    const inspectors = () => view.messages.filter((message) => message.type === 'inspector').length;
    const beforeUsage = inspectors();
    await sidebar.handleMessage({ type: 'usage', conversationId: 'front' });
    assert.equal(inspectors(), beforeUsage);
    await sidebar.handleMessage({ type: 'stop', conversationId: 'front' });
    await sidebar.handleMessage({ type: 'usage' });
    assert.match(String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text), /Usage|token|未取得|Not reported/);

    await sidebar.handleMessage({ type: 'logs' });
    assert.equal(output.shown, true);
    await sidebar.handleMessage({ type: 'settings' });
    assert.deepEqual(commands.executed.at(-1), { command: 'workbench.action.openSettings', args: ['ai-agents'] });
    await sidebar.handleMessage({ type: 'dismissWarning', id: 'banner-1' });
    assert.equal(context.workspaceState.get('ai-agents.dismissedWarning'), 'banner-1');

    const probe = sidebar.probe();
    assert.ok(view.messages.some((message) => message.type === 'probe'));
    await sidebar.handleMessage({ type: 'probeResult', turns: 'nope' });
    await sidebar.handleMessage({ type: 'probeResult', turns: 3, pending: false, history: true, settings: false });
    assert.equal((await probe).turns, 3);

    await sidebar.handleMessage({ type: 'copy', text: 'copied', requestId: 'copy-1' }, view as never);
    assert.equal(env.clipboard.text, 'copied');
    assert.equal(view.messages.filter((message) => message.type === 'copyResult').at(-1)?.ok, true);
    env.clipboard.fail = true;
    await sidebar.handleMessage({ type: 'copy', text: 'secret', requestId: 'copy-2' }, view as never);
    assert.equal(view.messages.filter((message) => message.type === 'copyResult').at(-1)?.ok, false);
    env.clipboard.fail = false;
    await sidebar.handleMessage({ type: 'copy', text: 'x'.repeat(10_000_001), requestId: 'copy-3' }, view as never);
    assert.equal(env.clipboard.text, 'copied');

    await sidebar.handleMessage({ type: 'steer', id: 'missing' });
    await sidebar.handleMessage({ type: 'removeQueued', id: 'missing' });
    await sidebar.handleMessage({ type: 'sendNow', id: 'missing' });
    assert.equal(sidebar.controller.snapshot().queue.length, 0);
    workspace.configuration['ai-agents']!.maxBackgroundSessions = 0;
    await assert.rejects(() => sidebar.handleMessage({ type: 'enqueue', provider: 'codex', cwd: workspacePath, prompt: 'blocked', attachments: ['  note.txt  '] }), /同時に実行できる会話の上限/);
    workspace.configuration['ai-agents']!.maxBackgroundSessions = 3;
    assert.equal(sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);

    await assert.rejects(() => sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: workspacePath, prompt: '/compact' }), /コンテキスト圧縮に対応していません/);
    await assert.rejects(() => sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: workspacePath, prompt: 'x'.repeat(100_001) }), /100,000/);
    await assert.rejects(() => sidebar.handleMessage({ type: 'send', provider: 'nope', cwd: workspacePath, prompt: 'hi' }), /エージェント設定が不正です/);
    await assert.rejects(() => sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: workspacePath, prompt: 'hi', images: [{ mimeType: 'text/plain', data: 'aaaa' }] }), /画像/);
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: workspacePath, prompt: '   ' });
    const frozenBefore = readFileSync(path.join(workspacePath, 'frozen.txt'), 'utf8');
    await sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: workspacePath, prompt: '/clear' });
    assert.equal(readFileSync(path.join(workspacePath, 'frozen.txt'), 'utf8'), frozenBefore);

    workspace.findFilesResult = [Uri.file(path.join(workspacePath, 'AGENTS.md'))];
    await sidebar.handleMessage({ type: 'suggest', kind: 'file', query: 'AGE', requestId: 4 });
    assert.ok((view.messages.filter((message) => message.type === 'suggestions').at(-1)?.items as Array<{ token: string }>).some((item) => item.token === 'AGENTS.md'));
    await sidebar.handleMessage({ type: 'suggest', kind: 'slash', query: 'diag', requestId: 5 });
    assert.ok((view.messages.filter((message) => message.type === 'suggestions').at(-1)?.items as Array<{ token: string }>).some((item) => item.token === 'diagnostics'));

    window.activeTextEditor = {
      document: { uri: Uri.file(path.join(workspacePath, 'AGENTS.md')), getText: () => 'line', lineCount: 1, lineAt: () => ({ text: 'line' }) },
      selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    };
    await sidebar.insertContext('selection');
    assert.match(String(view.messages.filter((message) => message.type === 'insert').at(-1)?.text), /AGENTS\.md:1-1/);
    await sidebar.handleMessage({ type: 'attach', kind: 'problems' });
    assert.match(String(view.messages.filter((message) => message.type === 'insert').at(-1)?.text), /No errors or warnings/);
    await sidebar.handleMessage({ type: 'attach', kind: 'terminal' });
    assert.match(String(view.messages.filter((message) => message.type === 'insert').at(-1)?.text), /ターミナル|terminal|コマンド/i);

    window.shellListeners[0]?.({ exitCode: 0, execution: { commandLine: 'echo from-sidebar' } });
    await sidebar.insertContext('terminal');
    assert.match(String(view.messages.filter((message) => message.type === 'insert').at(-1)?.text), /echo from-sidebar \(exit 0\)/);

    const permission = sidebar.controller.interactions.requestPermission({ id: 'perm-1', title: 'Run', detail: 'ls', kind: 'shell' });
    await settle();
    assert.equal(view.badge?.value, 1);
    await sidebar.handleMessage({ type: 'resolvePermission', id: 'other', decision: 'allow-once' });
    await sidebar.handleMessage({ type: 'resolvePermission', id: 'perm-1', decision: 'deny' });
    assert.equal(await permission, 'deny');
    const plan = sidebar.controller.interactions.requestPlan({ id: 'plan-1', plan: '# Plan', todos: [] });
    await settle();
    await sidebar.handleMessage({ type: 'resolvePlan', id: 'plan-1', decision: 'rejected' });
    assert.equal(await plan, 'rejected');
    const question = sidebar.controller.interactions.requestAnswers({ id: 'q-1', questions: [] });
    await settle();
    await sidebar.handleMessage({ type: 'resolveQuestion', id: 'q-1', answers: { q: ['yes'] } });
    assert.deepEqual(await question, { q: ['yes'] });

    await sidebar.handleMessage({ type: 'buildPlan', planId: 'missing', revision: 1 });
    await sidebar.handleMessage({ type: 'setBuildModel', modelId: 'gpt-test' });
    await sidebar.handleMessage({ type: 'setBuildParam', id: '' });
    await assert.rejects(() => sidebar.handleMessage({ type: 'openTerminal', processId: 'gone' }), /バックグラウンドターミナルがありません/);
    await sidebar.handleMessage({ type: 'terminateTerminal', processId: '' });
    await sidebar.handleMessage({ type: 'terminateTerminal', processId: 'gone' });
    await assert.rejects(() => sidebar.handleMessage({ type: 'rewind', turnId: 'missing', editedText: 'next' }), /見つかりません/);
    assert.equal(readFileSync(path.join(workspacePath, 'frozen.txt'), 'utf8'), 'frozen');

    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: workspacePath });
    assert.equal(sidebar.controller.snapshot().selection.provider, 'cursor');
    await sidebar.handleMessage({ type: 'configure', sandbox: 'disabled' });
    assert.match(window.warningMessages.at(-1) ?? '', /サンドボックスを無効/);
    assert.notEqual(harness.context.workspaceState.get<Record<string, { sandbox: string }>>('ai-agents.controls')?.cursor?.sandbox, 'disabled');
    window.warningQueue.push({ value: '保護を解除する' });
    await sidebar.handleMessage({ type: 'configure', sandbox: 'disabled' });
    assert.equal(harness.context.workspaceState.get<Record<string, { sandbox: string }>>('ai-agents.controls')?.cursor?.sandbox, 'disabled');
    await sidebar.handleMessage({ type: 'configure', mode: 'plan' });
    assert.equal(states(view).at(-1)?.shell.mode, 'plan');

    window.openDialogQueue.push(undefined);
    await sidebar.handleMessage({ type: 'addDirectory' });
    window.openDialogQueue.push([Uri.file(path.join(workspacePath, 'extra'))]);
    await sidebar.handleMessage({ type: 'addDirectory' });
    window.openDialogQueue.push([Uri.file(path.join(workspacePath, 'extra'))]);
    await sidebar.handleMessage({ type: 'addDirectory' });
    assert.deepEqual(states(view).at(-1)?.shell.additionalDirectories, [path.join(workspacePath, 'extra')]);
    await sidebar.handleMessage({ type: 'removeDirectory', path: path.join(workspacePath, 'extra') });
    assert.deepEqual(states(view).at(-1)?.shell.additionalDirectories, []);

    await sidebar.signIn();
    assert.equal(commands.executed.at(-1)?.command, 'ai-agents.cursorLogin');
    await sidebar.handleMessage({ type: 'select', provider: 'codex', cwd: workspacePath });
    await sidebar.signIn();
    assert.equal(window.terminals.at(-1)?.sent[0], 'codex login');
    assert.equal(window.terminals.at(-1)?.shown, 1);
    await sidebar.setApiKey();
    assert.equal(commands.executed.at(-1)?.command, 'ai-agents.setCodexApiKey');
    await sidebar.showInstructions();
    assert.match(String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text), /AGENTS\.md/);
    await sidebar.showDiagnostics();
    assert.match(String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text), /FAIL/);
    await sidebar.handleMessage({ type: 'refreshSessions' });
    assert.ok(Array.isArray(context.workspaceState.get('ai-agents.sessionIndex')));

    window.warningQueue.push({ value: undefined });
    await sidebar.handleMessage({ type: 'toggleAutoApprove' });
    assert.equal(sidebar.controller.snapshot().autoApprove, false);
    window.warningQueue.push({ value: 'Enable' });
    await sidebar.handleMessage({ type: 'toggleAutoApprove' });
    assert.equal(sidebar.controller.snapshot().autoApprove, true);
    assert.equal(workspace.configurationUpdates.at(-1)?.target, ConfigurationTarget.Global);
    assert.match(sidebar.controller.snapshot().messages.at(-1)?.text ?? '', /Auto-approve is on/);

    workspace.configuration['ai-agents']!.autoApprove = false;
    workspace.fireConfiguration((key) => key === 'ai-agents.autoApprove');
    assert.equal(sidebar.controller.snapshot().autoApprove, false);
    const ignored = sidebar.controller.snapshot().autoApprove;
    workspace.fireConfiguration(() => false);
    assert.equal(sidebar.controller.snapshot().autoApprove, ignored);

    view.viewType = 'ai-agents.secondaryChat';
    await sidebar.openPanel('history');
    assert.equal(commands.executed.at(-1)?.command, 'ai-agents.secondaryChat.focus');
    assert.equal(view.messages.filter((message) => message.type === 'navigate').at(-1)?.panel, 'history');
    await sidebar.stop();

    commands.failures.set('workbench.action.openSettings', () => new Error('settings token=abc123'));
    view.receive({ type: 'settings' });
    await waitFor(() => window.errorMessages.some((message) => message.includes('token=[redacted]')), 'settings error');
    assert.ok(view.messages.some((message) => message.type === 'error' && String(message.text).includes('token=[redacted]')));
    view.dispose();
    assert.equal(sidebar.isReady(), false);
    workspace.fireWorkspaceFolders();
    await settle();
  } finally {
    await close(harness);
  }
});

test('restored messages get icon decorations and file review does not touch unrelated files', async () => {
  resetVscode();
  const id = 'abababab-abab-abab-abab-abababababab';
  const harness = openSidebar(({ context, workspacePath }) => {
    const history = path.join(context.storageUri.fsPath, 'history', 'v1');
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, `${id}.json`), JSON.stringify({
      version: 1, id, updatedAt: '2026-01-01T00:00:00.000Z',
      controls: { mode: 'agent', sandbox: 'workspace-write', approval: 'never', backend: 'sdk', network: false, webSearch: '', additionalDirectories: [] },
      state: {
        selection: { provider: 'codex', cwd: workspacePath, model: '' }, busy: false,
        messages: [
          { id: 'user-1', role: 'user', text: 'hello history' },
          { id: 'user-2', role: 'user', text: 'with file', attachments: ['note.txt'] },
          { id: 'assistant-1', role: 'assistant', text: 'edited app.ts', meta: { type: 'files', files: [{ path: 'src/app.ts', kind: 'update' }] } },
        ],
        queue: [], status: 'idle', usage: null,
        changes: [
          { path: 'edit.txt', kind: 'update', previousText: 'old', diff: 'diff --git a/edit.txt\n-old\n+new' },
          { path: 'turn.diff', kind: 'update', diff: 'diff --git a/a\n+hello' },
        ],
        todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
        plan: { phase: 'idle', revisions: [] }, turns: [], subagents: [], terminals: [],
      },
    }));
  });
  const themeDir = path.join(harness.root, 'theme');
  mkdirSync(themeDir, { recursive: true });
  const theme = {
    iconDefinitions: { ts: { iconPath: 'dark.svg' } },
    fileExtensions: { ts: 'ts' },
    fonts: [{ id: 'codicon', src: [{ path: 'codicon.ttf', format: 'truetype' }] }],
    light: { fileExtensions: { ts: 'ts-light' }, iconDefinitions: { 'ts-light': { iconPath: 'light.svg' } } },
    highContrast: { fileExtensions: { ts: 'ts-hc' }, iconDefinitions: { 'ts-hc': { fontCharacter: 'T', fontColor: '#fff', fontId: 'codicon' } } },
  };
  writeFileSync(path.join(harness.workspacePath, 'edit.txt'), 'new');
  writeFileSync(path.join(harness.workspacePath, 'frozen.txt'), 'frozen');
  workspace.files.set(path.join(themeDir, 'icons.json'), new TextEncoder().encode(JSON.stringify(theme)));
  extensions.all = [{
    extensionUri: Uri.file(themeDir),
    packageJSON: { contributes: { iconThemes: [{ id: 'missing', path: 'missing.json' }, { id: 'fixture', path: 'icons.json' }] } },
  }];
  workspace.configuration.workbench = { iconTheme: 'missing' };
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'restoreSession', id });
    await waitFor(() => states(view).some((state) => state.messages.upserts.some((message) => message.meta?.files?.[0]?.icon?.type === 'badge')), 'badge icon');
    assert.equal(states(view).at(-1)?.messages.upserts.find((message) => message.id === 'assistant-1')?.meta?.files?.[0]?.icon?.badge, 'TS');
    workspace.configuration.workbench = { iconTheme: 'fixture' };
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 'icons' });
    await waitFor(() => states(view).some((state) => state.messages.upserts.some((message) => message.id === 'assistant-1' && String(message.meta?.files?.[0]?.icon?.src).includes('dark.svg'))), 'dark icon');
    assert.ok(states(view).some((state) => state.shell.changes.some((change) => change.name === 'edit.txt' && change.icon?.type === 'badge')));
    window.activeColorTheme = { kind: ColorThemeKind.Light };
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 'light' });
    await waitFor(() => states(view).some((state) => String(state.messages.upserts.find((message) => message.id === 'assistant-1')?.meta?.files?.[0]?.icon?.src).includes('light.svg')), 'light icon');
    window.activeColorTheme = { kind: ColorThemeKind.HighContrast };
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 'hc' });
    await waitFor(() => states(view).some((state) => state.messages.upserts.some((message) => message.meta?.files?.[0]?.icon?.type === 'font' && message.meta.files[0]?.icon?.fontCharacter === 'T')), 'hc icon');

    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'user-1' }, view as never);
    assert.equal(view.messages.filter((message) => message.type === 'retryPrepared').at(-1)?.id, 'user-1');
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'user-2' }, view as never);
    assert.match(String(view.messages.filter((message) => message.type === 'error').at(-1)?.text), /添付を再指定/);
    await harness.sidebar.handleMessage({ type: 'openFile', path: 'edit.txt', line: 2, column: 1 });
    assert.equal(window.visibleEditors.at(-1)?.selection?.start.line, 1);
    assert.equal(readFileSync(path.join(harness.workspacePath, 'edit.txt'), 'utf8'), 'new');
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'openFile', path: '/etc/passwd' }), /ワークスペース外/);
    await harness.sidebar.handleMessage({ type: 'openDiff', path: 'turn.diff' });
    assert.match(String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text), /\+hello/);
    commands.failures.set('vscode.changes', () => new Error('no multi-file diff'));
    await harness.sidebar.handleMessage({ type: 'reviewChanges' });
    assert.ok(commands.executed.some((entry) => entry.command === 'vscode.changes'));
    assert.ok(commands.executed.some((entry) => entry.command === 'vscode.diff'));
    assert.equal(readFileSync(path.join(harness.workspacePath, 'edit.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(path.join(harness.workspacePath, 'frozen.txt'), 'utf8'), 'frozen');
    await harness.sidebar.handleMessage({ type: 'revertFile', path: 'edit.txt' });
    assert.equal(readFileSync(path.join(harness.workspacePath, 'edit.txt'), 'utf8'), 'old');
    assert.match(harness.sidebar.controller.snapshot().messages.at(-1)?.text ?? '', /Reverted edit\.txt/);
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server' });
    assert.match(harness.sidebar.controller.snapshot().messages.at(-1)?.text ?? '', /新しい会話/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
  } finally {
    await close(harness);
  }
});

test('model menu selection uses a local codex stub and asks before replacing a conversation', { timeout: 15_000 }, async () => {
  resetVscode();
  const scriptDir = mkdtempSync(path.join(tmpdir(), 'ai-agents-fake-codex-'));
  const fake = writeFakeCodex(scriptDir);
  const harness = openSidebar();
  workspace.configuration['ai-agents']!['codex.executablePath'] = fake;
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    const details = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.length > 0, 'model picker');
    window.quickPicks.at(-1)?.hide();
    await details;
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');

    await harness.sidebar.handleMessage({ type: 'setModel', modelId: 'gpt-test' });
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'gpt-test');
    assert.equal(window.warningMessages.length, 0);
    const saved = harness.context.workspaceState.get<Record<string, { model: string; label: string }>>('ai-agents.selectedModels');
    assert.equal(saved?.codex?.model, 'gpt-test');
    assert.equal(saved?.codex?.label, 'GPT Test');
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'modelReasoningEffort', value: 'high' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'high' }]);
    await harness.sidebar.handleMessage({ type: 'setModelParam', id: 'modelReasoningEffort', value: 'nope' });
    assert.deepEqual(harness.sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'high' }]);
    await assert.rejects(() => harness.sidebar.handleMessage({ type: 'setModel', modelId: 'missing' }), /モデル一覧に、そのモデルはありません/);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 4, refresh: true });
    const catalog = view.messages.filter((message) => message.type === 'modelCatalog').at(-1);
    assert.equal(catalog?.status, 'ready');
    assert.equal((catalog?.models as Array<{ id: string }> | undefined)?.[0]?.id, 'gpt-test');

    const choosing = harness.sidebar.handleMessage({ type: 'chooseModel' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false && (window.quickPicks.at(-1)?.items.length ?? 0) > 0, 'picker items');
    window.quickPicks.at(-1)?.hide();
    await choosing;
    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'gpt-test');
    await close(harness);
  } catch (error) {
    await close(harness);
    rmSync(scriptDir, { recursive: true, force: true });
    throw error;
  }

  resetVscode();
  const id = 'edededed-eded-eded-eded-edededededed';
  const again = openSidebar(({ context, workspacePath }) => {
    const history = path.join(context.storageUri.fsPath, 'history', 'v1');
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, `${id}.json`), JSON.stringify({
      version: 1, id, updatedAt: '2026-01-01T00:00:00.000Z',
      controls: { mode: 'agent', sandbox: 'workspace-write', approval: 'never', backend: 'sdk', network: false, webSearch: '', additionalDirectories: [] },
      state: {
        selection: { provider: 'codex', cwd: workspacePath, model: '' }, busy: false,
        messages: [{ id: 'user-1', role: 'user', text: 'keep this chat' }],
        queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [], autoApprove: false,
        pendingPermission: null, pendingPlan: null, pendingQuestion: null, plan: { phase: 'idle', revisions: [] },
        turns: [], subagents: [], terminals: [],
      },
    }));
  });
  workspace.configuration['ai-agents']!['codex.executablePath'] = fake;
  try {
    await again.sidebar.flushHistory();
    await again.sidebar.handleMessage({ type: 'restoreSession', id });
    assert.ok(again.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'));
    await again.sidebar.handleMessage({ type: 'setModel', modelId: 'gpt-test' });
    assert.match(window.warningMessages.at(-1) ?? '', /new session/i);
    assert.equal(again.sidebar.controller.snapshot().selection.model, '');
    assert.ok(again.sidebar.controller.snapshot().messages.some((message) => message.text === 'keep this chat'));
    window.warningQueue.push({ value: 'Start new session' });
    await again.sidebar.handleMessage({ type: 'setModel', modelId: 'gpt-test' });
    assert.equal(again.sidebar.controller.snapshot().selection.model, 'gpt-test');
  } finally {
    await close(again);
    rmSync(scriptDir, { recursive: true, force: true });
  }
});

test('a failed model catalog is posted without launching the bundled CLI', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    await harness.sidebar.handleMessage({ type: 'loadModelCatalog', requestId: 9, refresh: true });
    const catalog = view.messages.filter((message) => message.type === 'modelCatalog').at(-1);
    assert.equal(catalog?.status, 'error');
    assert.match(String(catalog?.error), /終了しました|ENOENT/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
  } finally {
    await close(harness);
  }
});

test('Japanese locale uses Japanese confirmation copy', async () => {
  resetVscode();
  env.language = 'ja';
  const harness = openSidebar();
  const view = createView();
  try {
    await ready(harness.sidebar, view);
    assert.match(view.webview.html, /lang="ja"/);
    window.warningQueue.push({ value: '有効にする' });
    await harness.sidebar.handleMessage({ type: 'toggleAutoApprove' });
    assert.match(window.warningMessages[0] ?? '', /自動承認を有効にしますか/);
    assert.match(harness.sidebar.controller.snapshot().messages.at(-1)?.text ?? '', /自動承認を有効にしました/);
    assert.equal(harness.sidebar.controller.snapshot().autoApprove, true);
  } finally {
    await close(harness);
  }
});
