import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';
import { commands, env, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round9-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  }));
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, sessionFactory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('rewind confirmation formats long previews and preserves saved image and attachment payloads', async () => {
  resetVscode();
  const harness = withSession();
  const captured: Array<{ id: string; text: string; extras: unknown }> = [];
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed rewind state' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(id: string, text: string, extras: unknown): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    const turn = state.turns[0]!;
    const user = state.messages.find((message) => message.role === 'user')!;
    turn.id = 'backend-local-turn';
    turn.userMessageId = user.id;
    turn.imageCount = 1;
    user.attachments = ['notes.md'];
    harness.sidebar.controller.restoreSnapshot(state);
    controller.retryInput = () => ({ prompt: 'original saved prompt', extras: {
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }], attachments: ['notes.md'],
    } });
    controller.previewRewind = async (id: string) => {
      assert.equal(id, user.id, 'lookup accepts the user message ID of a retry turn');
      return { targetId: turn.id, prompt: 'original '.repeat(30), removedTurns: 3, files: Array.from({ length: 9 }, (_, index) => `file-${index}.txt`) };
    };
    controller.rewindAndSend = async (id, text, extras) => { captured.push({ id, text, extras }); };
    window.warningQueue.push({ value: 'Rewind and resend' });
    const edited = 'replacement '.repeat(20);

    await harness.sidebar.handleMessage({ type: 'rewind', turnId: user.id, editedText: edited });

    const warning = window.warningMessages.at(-1) ?? '';
    assert.match(warning, /Original: original original/);
    assert.match(warning, /Replacement: replacement replacement/);
    assert.match(warning, /and 2 later turn\(s\)/);
    assert.match(warning, /file-0\.txt, file-1\.txt, file-2\.txt, file-3\.txt, file-4\.txt, file-5\.txt, file-6\.txt, file-7\.txt, and more/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.id, 'backend-local-turn');
    assert.equal(captured[0]?.text, edited.trim());
    assert.deepEqual(captured[0]?.extras, {
      displayText: edited.trim(),
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
      attachments: ['notes.md'],
    });
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'replacement '.repeat(20).trim()), false,
      'the synthetic rewind seam captures the payload without starting an unintended second run');
  } finally {
    await close(harness);
  }
});

test('rewind handles the Japanese no-file preview and refuses missing local message or attachment data', async () => {
  resetVscode();
  env.language = 'ja-JP';
  const harness = withSession();
  const originalWarning = window.showWarningMessage;
  let confirmationArguments: unknown[] = [];
  window.showWarningMessage = (message: string, ...args: unknown[]) => {
    confirmationArguments = args;
    return originalWarning(message, ...args);
  };
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'seed' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(): Promise<void>;
    };
    const original = harness.sidebar.controller.snapshot();
    const user = original.messages.find((message) => message.role === 'user')!;
    const turn = original.turns[0]!;
    controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'seed', removedTurns: 1, files: [] });
    controller.rewindAndSend = async () => {};
    controller.retryInput = () => undefined;

    const withoutUser = structuredClone(original);
    withoutUser.messages = withoutUser.messages.filter((message) => message.id !== user.id);
    harness.sidebar.controller.restoreSnapshot(withoutUser);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /ローカル履歴にありません/);

    harness.sidebar.controller.restoreSnapshot(original);
    const attachmentState = structuredClone(original);
    attachmentState.messages.find((message) => message.id === user.id)!.attachments = ['missing.md'];
    harness.sidebar.controller.restoreSnapshot(attachmentState);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /添付の元データが保存されていません/);

    const imageState = structuredClone(original);
    imageState.turns[0]!.imageCount = 1;
    harness.sidebar.controller.restoreSnapshot(imageState);
    await assert.rejects(harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' }), /元画像はローカル履歴に保存されていないため/);

    harness.sidebar.controller.restoreSnapshot(original);
    window.warningQueue.push({ value: undefined });
    await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: 'edit' });
    assert.match(window.warningMessages.at(-1) ?? '', /復元するファイル変更はありません/);
    assert.ok(confirmationArguments.some((value) => value === '巻き戻して再実行'));
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.text === 'seed'), true);
  } finally {
    window.showWarningMessage = originalWarning;
    await close(harness);
  }
});

test('settings and interaction routes preserve validated approval and resolve only valid payloads', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    await harness.sidebar.handleMessage({ type: 'configure', backend: 'app-server', approval: 'on-request' });
    assert.equal(harness.context.workspaceState.get<Record<string, { backend: string; approval: string }>>('ai-agents.controls')?.codex?.backend, 'app-server');
    assert.equal(harness.context.workspaceState.get<Record<string, { backend: string; approval: string }>>('ai-agents.controls')?.codex?.approval, 'on-request');

    const permission = harness.sidebar.controller.interactions.requestPermission({ id: 'late-permission', title: 'Write file', detail: 'notes.md', kind: 'write' });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission' });
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission', decision: 'allow' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPermission?.id, 'late-permission');
    await harness.sidebar.handleMessage({ type: 'resolvePermission', id: 'late-permission', decision: 'allow-session' });
    assert.equal(await permission, 'allow-session');

    const plan = harness.sidebar.controller.interactions.requestPlan({ id: 'late-plan', plan: '# Plan', todos: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 9, decision: 'accepted' });
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'late-plan' });
    assert.equal(harness.sidebar.controller.snapshot().pendingPlan?.id, 'late-plan');
    await harness.sidebar.handleMessage({ type: 'resolvePlan', id: 'late-plan', decision: 'rejected' });
    assert.equal(await plan, 'rejected');

    const answers = harness.sidebar.controller.interactions.requestAnswers({
      id: 'late-question', questions: [{ id: 'continue', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 10, answers: { continue: ['yes'] } });
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion?.id, 'late-question');
    await harness.sidebar.handleMessage({ type: 'resolveQuestion', id: 'late-question', answers: { continue: ['yes'] } });
    assert.deepEqual(await answers, { continue: ['yes'] });
    assert.equal(harness.sidebar.controller.snapshot().pendingQuestion, null);
  } finally {
    await close(harness);
  }
});

test('Build routes apply the saved model fallback and acknowledge only the selected build model', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: Selection): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 4, createdAt: 4, source: 'assistant-text', markdown: '# Build' }],
      current: { id: 'late-build', revision: 4, markdown: '# Build', todos: [], source: 'assistant-text', createdAt: 4 },
      build: { selection: { ...state.selection, model: 'saved-build-model', modelParams: [{ id: 'effort', value: 'high' }] }, label: 'Saved model' },
    };
    harness.sidebar.controller.restoreSnapshot(state);
    const builds: Array<{ id: string; revision: number; selection: Selection }> = [];
    controller.build = async (id, revision, selection) => {
      builds.push({ id, revision, selection });
      const next = harness.sidebar.controller.snapshot();
      next.selection = selection;
      next.plan.phase = 'implemented';
      harness.sidebar.controller.restoreSnapshot(next);
    };

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'late-build', revision: 4 });
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.selection.model, 'saved-build-model');
    assert.deepEqual(builds[0]?.selection.modelParams, [{ id: 'effort', value: 'high' }]);
    const saved = harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(saved, { model: 'saved-build-model', label: 'saved-build-model', hasDetails: true, modelParams: [{ id: 'effort', value: 'high' }] });

    const model = { id: 'canonical-build-model', label: '', aliases: ['build-alias'] };
    harness.sidebar.listAvailableModels = async () => [model];
    const readyAgain = harness.sidebar.controller.snapshot();
    readyAgain.plan.phase = 'ready';
    readyAgain.plan.current = { id: 'alias-plan', revision: 5, markdown: '# Alias', todos: [], source: 'assistant-text', createdAt: 5 };
    readyAgain.plan.revisions = [{ revision: 5, createdAt: 5, source: 'assistant-text', markdown: '# Alias' }];
    harness.sidebar.controller.restoreSnapshot(readyAgain);
    await harness.sidebar.handleMessage({ type: 'setBuildModel', modelId: 'build-alias' });
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.selection.model, 'canonical-build-model');
    assert.equal(harness.sidebar.controller.snapshot().plan.build?.label, 'build-alias');
  } finally {
    await close(harness);
  }
});

test('review routes build multi-file entries and open file URLs with a bounded selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const file = path.join(harness.workspacePath, 'review.txt');
  const originalParse = Uri.parse;
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [
      { path: 'review.txt', kind: 'delete', previousText: null },
      { path: file, kind: 'update', previousText: 'before' },
      { path: 'turn.diff', kind: 'update', previousText: 'synthetic patch', diff: '+not a workspace file' },
      { path: '../outside.txt', kind: 'update', previousText: 'unsafe' },
    ];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'reviewChanges' });

    const review = commands.executed.find((entry) => entry.command === 'vscode.changes');
    assert.ok(review, 'the multi-file review command is invoked for recoverable workspace changes');
    const entries = review.args[1] as Array<[Uri, Uri | undefined, Uri | undefined]>;
    assert.equal(entries.length, 2, 'synthetic and out-of-workspace paths are omitted');
    assert.equal(entries[0]?.[0].fsPath, file);
    assert.equal(entries[0]?.[2], undefined, 'deleted files have no current side in the diff');
    assert.equal(entries[1]?.[2]?.fsPath, file);

    Object.defineProperty(Uri, 'parse', {
      configurable: true,
      value: (value: string) => Uri.file(fileURLToPath(value)),
    });
    await harness.sidebar.handleMessage({
      type: 'openFile', path: pathToFileURL(file).toString(), line: '2', column: '0', endLine: '99',
    });
    const editor = window.visibleEditors.at(-1)!;
    assert.equal(editor.document.uri.fsPath, file);
    assert.equal(editor.selection?.start.line, 1);
    assert.equal(editor.selection?.start.character, 0);
    assert.equal(editor.selection?.end.line, 3, 'selection end is clamped to the document line count');
    assert.equal(editor.selection?.end.character, 6);
    assert.equal(editor.revealed.at(-1)?.end.line, editor.selection?.end.line);
    assert.equal(editor.revealed.at(-1)?.end.character, editor.selection?.end.character);
  } finally {
    Object.defineProperty(Uri, 'parse', { configurable: true, value: originalParse });
    await close(harness);
  }
});

test('icon theme discovery skips malformed contributions and renders a font icon without a font asset', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'late-icons' };
  const harness = openSidebar();
  const view = createView();
  const themeDir = path.join(harness.root, 'icon-theme');
  mkdirSync(themeDir, { recursive: true });
  const themeFile = Uri.file(path.join(themeDir, 'icons.json'));
  workspace.files.set(themeFile.fsPath, new TextEncoder().encode(JSON.stringify({
    fileExtensions: { zz: 'glyph' },
    iconDefinitions: { glyph: { fontCharacter: 'Z', fontId: 'fixture-font' } },
    fonts: [{ id: 'fixture-font', src: [] }],
  })));
  extensions.all.push(
    { extensionUri: Uri.file(path.join(harness.root, 'no-contributions')), packageJSON: {} },
    { extensionUri: Uri.file(path.join(harness.root, 'no-path')), packageJSON: { contributes: { iconThemes: [{ id: 'other', path: 'ignored.json' }, { id: 'late-icons' }] } } },
    { extensionUri: Uri.file(themeDir), packageJSON: { contributes: { iconThemes: [{ id: 'late-icons', path: 'icons.json' }] } } },
  );
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'sample.zz', kind: 'update', previousText: 'old' }];
    state.messages = [{ id: 'theme-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'sample.zz', kind: 'update', previousText: 'old' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await waitFor(() => {
      const message = view.messages.filter((item) => item.type === 'state').at(-1) as { messages?: { upserts?: Array<{ meta?: { files?: Array<{ icon?: { type?: string } }> } }> } } | undefined;
      return message?.messages?.upserts?.some((item) => item.meta?.files?.[0]?.icon?.type === 'font') === true;
    }, 'font themed file icon');

    const stateMessage = view.messages.filter((item) => item.type === 'state').at(-1) as {
      messages: { upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: Record<string, unknown> }> } }> };
      shell: { changes: Array<{ name: string; icon?: Record<string, unknown> }> };
    };
    const icon = stateMessage.messages.upserts.find((item) => item.id === 'theme-message')?.meta?.files?.[0]?.icon;
    assert.equal(icon?.type, 'font');
    assert.equal(icon?.fontCharacter, 'Z');
    assert.equal(icon?.badge, 'ZZ');
    assert.equal('src' in (icon ?? {}), false, 'font definitions without a source path render without a font asset URL');
    assert.equal('fontColor' in (icon ?? {}), false, 'missing font color stays omitted');
    assert.equal(stateMessage.shell.changes.find((change) => change.name === 'sample.zz')?.icon?.type, 'font');
  } finally {
    await close(harness);
  }
});

test('adding and removing an additional directory persists settings and resets a live session', async () => {
  resetVscode();
  const harness = withSession();
  const additional = path.join(harness.root, 'additional');
  mkdirSync(additional, { recursive: true });
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active before directory change' });
    window.openDialogQueue.push([Uri.file(additional)]);
    await harness.sidebar.handleMessage({ type: 'addDirectory' });
    let controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex;
    assert.deepEqual(controls?.additionalDirectories, [additional]);
    assert.equal(harness.sidebar.controller.hasSession(), false, 'changing allowed directories resets the session that used the old policy');

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'active before removing directory' });
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: additional });
    controls = harness.context.workspaceState.get<Record<string, { additionalDirectories: string[] }>>('ai-agents.controls')?.codex;
    assert.deepEqual(controls?.additionalDirectories, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
    assert.ok(harness.sidebar.controller.snapshot().messages.some((message) => message.text.includes('Started a new conversation')));
  } finally {
    await close(harness);
  }
});

test('Cursor diagnostics report synthetic CLI and SDK status; usage shows live and unsupported backends', async () => {
  resetVscode();
  const harness = withSession(async () => ({
    sessionId: 'cursor-inspector-session',
    async run() {},
    async rateLimits() { return 'synthetic rate limits'; },
    async dispose() {},
  }));
  const view = createView();
  const cli = path.join(harness.root, 'cursor-agent.cjs');
  writeFileSync(cli, "process.stdout.write(process.argv[2] === '--version' ? 'Cursor fixture 0.1\\n' : 'status: ready\\n');\n");
  workspace.configuration['ai-agents']!['cursor.agentPath'] = cli;
  const sdk = await import('@cursor/sdk');
  const auth = sdk.Cursor.auth as unknown as { status: () => Promise<{ status: string }> };
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'status');
  assert.ok(descriptor);
  try {
    await harness.sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: harness.workspacePath });
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    Object.defineProperty(auth, 'status', { configurable: true, writable: true, value: async () => ({ status: 'logged-in' }) });
    await harness.sidebar.handleMessage({ type: 'diagnose' });

    const diagnostics = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(diagnostics, /OK Cursor CLI \(override\)/);
    assert.match(diagnostics, /Cursor fixture 0\.1/);
    assert.match(diagnostics, /status: ready/);
    assert.match(diagnostics, /OK Cursor SDK auth\nlogged-in/);
    assert.match(diagnostics, /Cursor sandbox helper/);

    await harness.sidebar.controller.openSession();
    const state = harness.sidebar.controller.snapshot();
    state.usage = { inputTokens: 120, outputTokens: 34, totalTokens: 154 };
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'usage' });
    const usage = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(usage, /Input 120 · Output 34 · Total 154/);
    assert.match(usage, /synthetic rate limits/);

    await harness.sidebar.handleMessage({ type: 'configure', backend: 'acp' });
    await harness.sidebar.handleMessage({ type: 'usage' });
    const unsupported = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(unsupported, /非対応 \/ Unsupported/);
    assert.equal(harness.sidebar.controller.hasSession(), false, 'switching backend drops the previous session before reporting unsupported usage');
  } finally {
    Object.defineProperty(auth, 'status', descriptor);
    await close(harness);
  }
});
