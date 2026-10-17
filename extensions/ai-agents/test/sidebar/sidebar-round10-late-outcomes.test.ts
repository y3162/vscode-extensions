import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentSession, AgentUpdate, Selection, SessionSummary } from '../../src/types.js';
import { commands, extensions, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round10-late-session',
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

test('English rewind confirmation covers an unchanged preview and omits absent saved media', async () => {
  resetVscode();
  const harness = withSession();
  const sent: Array<{ id: string; prompt: string; extras: unknown }> = [];
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'stable turn' });
    const controller = harness.sidebar.controller as unknown as {
      retryInput(id: string): unknown;
      previewRewind(id: string): Promise<unknown>;
      rewindAndSend(id: string, prompt: string, extras: unknown): Promise<void>;
    };
    const turn = harness.sidebar.controller.snapshot().turns[0]!;
    controller.retryInput = () => ({ prompt: 'stable turn' });
    controller.previewRewind = async () => ({ targetId: turn.id, prompt: 'stable turn', removedTurns: 1, files: [] });
    controller.rewindAndSend = async (id, prompt, extras) => { sent.push({ id, prompt, extras }); };
    window.warningQueue.push({ value: 'Rewind and resend' });

    await harness.sidebar.handleMessage({ type: 'rewind', turnId: turn.id, editedText: '  replacement  ' });

    assert.match(window.warningMessages.at(-1) ?? '', /Edit this prompt in place/);
    assert.match(window.warningMessages.at(-1) ?? '', /No file changes need restoring/);
    assert.deepEqual(sent, [{ id: turn.id, prompt: 'replacement', extras: { displayText: 'replacement' } }]);
  } finally {
    await close(harness);
  }
});

test('malformed Build requests do not mutate a plan, while typed fallbacks use its saved selection', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const controller = harness.sidebar.controller as unknown as {
      build(planId: string, revision: number, selection: Selection): Promise<void>;
    };
    const state = harness.sidebar.controller.snapshot();
    state.plan = {
      phase: 'ready',
      revisions: [{ revision: 6, createdAt: 6, source: 'assistant-text', markdown: '# Saved build' }],
      current: { id: 'saved-plan', revision: 6, markdown: '# Saved build', todos: [], source: 'assistant-text', createdAt: 6 },
      build: { selection: { ...state.selection, model: 'saved-model', modelParams: [{ id: 'effort', value: 'high' }] }, label: 'Saved model' },
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

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 6, revision: '6' });
    assert.equal(builds.length, 0, 'invalid plan id and revision are rejected by the ready-plan guard');
    assert.equal(harness.sidebar.controller.snapshot().plan.phase, 'ready');

    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'saved-plan', revision: 6, modelId: 8, modelParams: 'malformed' });
    assert.equal(builds.length, 1);
    assert.equal(builds[0]?.selection.model, 'saved-model', 'non-string model IDs fall back to the saved Build model');
    assert.deepEqual(builds[0]?.selection.modelParams, [{ id: 'effort', value: 'high' }], 'non-array parameters fall back to saved Build parameters');
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex, {
      model: 'saved-model', label: 'saved-model', hasDetails: true, modelParams: [{ id: 'effort', value: 'high' }],
    });

    const noBuild = harness.sidebar.controller.snapshot();
    noBuild.plan.phase = 'ready';
    noBuild.plan.current = { id: 'empty-build', revision: 7, markdown: '# Empty Build', todos: [], source: 'assistant-text', createdAt: 7 };
    noBuild.plan.revisions = [{ revision: 7, createdAt: 7, source: 'assistant-text', markdown: '# Empty Build' }];
    delete noBuild.plan.build;
    harness.sidebar.controller.restoreSnapshot(noBuild);
    await harness.sidebar.handleMessage({ type: 'buildPlan', planId: 'empty-build', revision: 7 });
    const selected = harness.context.workspaceState.get<Record<string, { model: string; label: string; hasDetails: boolean }>>('ai-agents.selectedModels')?.codex;
    assert.deepEqual(selected, { model: '', label: 'Select model', hasDetails: false });
  } finally {
    await close(harness);
  }
});

test('openDiff writes a null baseline as an empty file and refuses relative review without a workspace', async () => {
  resetVscode();
  const harness = openSidebar();
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'before-null.txt', kind: 'update', previousText: null }];
    harness.sidebar.controller.restoreSnapshot(state);
    await harness.sidebar.handleMessage({ type: 'openDiff', path: 'before-null.txt' });

    const diff = commands.executed.find((entry) => entry.command === 'vscode.diff');
    assert.ok(diff);
    const baseline = diff.args[0] as Uri;
    assert.equal(readFileSync(baseline.fsPath, 'utf8'), '', 'a null saved baseline is represented as an empty file');
    assert.equal((diff.args[1] as Uri).fsPath, path.join(harness.workspacePath, 'before-null.txt'));

    await harness.sidebar.controller.select({ provider: 'codex', cwd: '', model: '' });
    commands.executed.length = 0;
    await harness.sidebar.handleMessage({ type: 'openDiff', path: 'before-null.txt' });
    assert.equal(commands.executed.some((entry) => entry.command === 'vscode.diff'), false,
      'a relative change cannot be resolved when the selected conversation has no workspace');
  } finally {
    await close(harness);
  }
});

test('saved session backend is reused without a picker and later settings changes reset the session', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  const summary: SessionSummary = {
    id: 'saved-app-server-session', title: 'Saved app-server conversation', updatedAt: '2026-10-18T00:00:00.000Z',
    provider: 'codex', backend: 'app-server', cwd: paths.workspacePath,
  };
  await paths.context.workspaceState.update('ai-agents.sessionIndex', [summary]);
  const options: Array<{ backend?: string; resumeId?: string }> = [];
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async (value: { backend?: string; resumeId?: string }): Promise<AgentSession> => {
    options.push(value);
    return { sessionId: summary.id, async run() {}, async dispose() {} };
  }) as never);
  const harness: Harness = { ...paths, sidebar, output };
  try {
    await sidebar.handleMessage({ type: 'restoreSession', id: summary.id });
    assert.equal(options.length, 1);
    assert.equal(options[0]?.backend, 'app-server');
    assert.equal(options[0]?.resumeId, summary.id);
    assert.equal(window.quickPickOffers.length, 0, 'a saved backend avoids asking the user to choose it again');
    assert.equal(sidebar.controller.hasSession(), true);

    await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
    const controls = paths.context.workspaceState.get<Record<string, { backend: string }>>('ai-agents.controls');
    assert.equal(controls?.codex?.backend, 'sdk');
    assert.equal(sidebar.controller.hasSession(), false, 'changing backend retires the session that was opened with the saved backend');
    assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('設定を変更')));
  } finally {
    await close(harness);
  }
});

test('diagnostics use bundled Codex fallback and tolerate an empty workspace; instructions skip local lookup', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  const fakeCli = path.join(harness.root, 'fake-codex.cjs');
  writeFileSync(fakeCli, "process.stdout.write('Codex synthetic 1.0\\n');\n");
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    workspace.configuration['ai-agents']!['codex.executablePath'] = '';
    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const bundled = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(bundled, /Codex CLI \(bundled\)/, 'an empty executable setting selects the packaged Codex CLI');

    workspace.configuration['ai-agents']!['codex.executablePath'] = fakeCli;
    await harness.sidebar.controller.select({ provider: 'codex', cwd: '', model: '' });
    await harness.sidebar.handleMessage({ type: 'diagnose' });
    const noWorkspace = String(view.messages.filter((message) => message.type === 'inspector').at(-1)?.text);
    assert.match(noWorkspace, /Codex CLI \(override\)/);
    assert.match(noWorkspace, /Codex synthetic 1\.0/);

    await harness.sidebar.handleMessage({ type: 'instructions' });
    const instructions = view.messages.filter((message) => message.type === 'inspector').at(-1);
    assert.equal(instructions?.title, 'Rules / Skills / MCP');
    assert.equal(instructions?.text, '', 'without a workspace or session there are no local or live instruction sources');
  } finally {
    await close(harness);
  }
});

test('icon theme with no matching definition keeps badge fallback after an invalid theme file', async () => {
  resetVscode();
  workspace.configuration.workbench = { iconTheme: 'empty-icons' };
  const harness = openSidebar();
  const view = createView();
  const themeDir = path.join(harness.root, 'empty-theme');
  mkdirSync(themeDir, { recursive: true });
  const themeFile = Uri.file(path.join(themeDir, 'icons.json'));
  workspace.files.set(themeFile.fsPath, new TextEncoder().encode('{ invalid json'));
  extensions.all.push({
    extensionUri: Uri.file(themeDir),
    packageJSON: { contributes: { iconThemes: [{ id: 'unrelated', path: 'other.json' }, { id: 'empty-icons', path: 'icons.json' }] } },
  });
  try {
    const state = harness.sidebar.controller.snapshot();
    state.changes = [{ path: 'no-definition.abc', kind: 'update', previousText: 'old' }];
    state.messages = [{ id: 'empty-theme-message', role: 'assistant', text: 'file update', meta: {
      type: 'files', files: [{ path: 'no-definition.abc', kind: 'update', previousText: 'old' }],
    } }];
    harness.sidebar.controller.restoreSnapshot(state);
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);

    const last = view.messages.filter((message) => message.type === 'state').at(-1) as {
      messages: {
        upserts: Array<{ id: string; meta?: { files?: Array<{ icon?: { type?: string; badge?: string } }> } }>;
      };
      shell: { changes: Array<{ icon?: { type?: string; badge?: string } }> };
    };
    const messageIcon = last.messages.upserts.find((message) => message.id === 'empty-theme-message')?.meta?.files?.[0]?.icon;
    const shellIcon = last.shell.changes[0]?.icon;
    assert.equal(messageIcon?.type, 'badge');
    assert.equal(messageIcon?.badge, 'ABC');
    assert.equal(shellIcon?.type, 'badge');
    assert.equal(shellIcon?.badge, 'ABC');
  } finally {
    await close(harness);
  }
});
