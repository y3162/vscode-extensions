import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, AgentUpdate, Selection } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { commands, resetVscode, Uri, window } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('model details reuses an open model picker instead of creating a competing picker', async () => {
  resetVscode();
  const harness = openSidebar();
  harness.sidebar.listAvailableModels = async () => [{ id: 'round11-picker', label: 'Picker model' }];
  try {
    const picking = harness.sidebar.selectModel();
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'model picker catalog');
    const picker = window.quickPicks.at(-1)!;

    await harness.sidebar.handleMessage({ type: 'modelDetails' });

    assert.equal(window.quickPicks.length, 1);
    assert.equal(picker.shown, true);
    assert.equal(picker.disposed, false);
    picker.hide();
    await picking;
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
  } finally {
    await close(harness);
  }
});

test('details resolve a saved model alias and reset its Codex parameter to the unspecified default', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'round11-canonical-model', label: 'Canonical settings model', aliases: ['round11-short-name'],
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  await harness.sidebar.controller.select({
    provider: 'codex', cwd: harness.workspacePath, model: 'round11-short-name', modelParams: [{ id: 'effort', value: 'high' }],
  });
  harness.sidebar.listAvailableModels = async () => [model];
  try {
    const editing = harness.sidebar.handleMessage({ type: 'modelDetails' });
    await waitFor(() => window.quickPicks.at(-1)?.busy === false, 'aliased model details');
    const picker = window.quickPicks.at(-1)!;
    const reset = picker.items.find((item) => (item as { action?: string }).action === 'reset');
    assert.ok(reset);
    picker.selectedItems = [reset];
    picker.accept();

    const apply = picker.items.find((item) => (item as { action?: string }).action === 'apply');
    assert.ok(apply);
    picker.selectedItems = [apply];
    picker.accept();
    await editing;

    assert.equal(harness.sidebar.controller.snapshot().selection.model, 'round11-short-name');
    assert.equal(harness.sidebar.controller.snapshot().selection.modelParams, undefined);
    assert.deepEqual(harness.context.workspaceState.get<Record<string, { model: string; label: string; modelParams?: unknown[] }>>('ai-agents.selectedModels')?.codex, {
      model: 'round11-short-name', label: 'Canonical settings model', hasDetails: true,
    });
    assert.equal(picker.disposed, true);
  } finally {
    await close(harness);
  }
});

test('context insertion waits for a ready webview and emits nothing when the editor has no selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    const inserting = harness.sidebar.insertContext('selection');
    await waitFor(() => commands.executed.some((entry) => entry.command === 'ai-agents.chat.focus'), 'focus request');
    assert.equal(harness.sidebar.isReady(), false);

    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await inserting;

    assert.equal(harness.sidebar.isReady(), true);
    assert.equal(view.messages.some((message) => message.type === 'insert'), false, 'missing selection does not fabricate context text');
  } finally {
    await close(harness);
  }
});

test('the diff built-in sends a synthetic workspace summary and keeps the original request visible', async () => {
  resetVscode();
  const runs: string[] = [];
  const harness = withFactory(async () => ({
    sessionId: 'round11-diff-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      runs.push(prompt);
      emit({ id: 'round11-diff-final', role: 'assistant', text: 'summary returned', final: true });
    },
    async dispose() {},
  }));
  writeFileSync(path.join(harness.workspacePath, 'change-notes.md'), 'synthetic diff context');
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/diff Summarize @change-notes.md' });

    assert.equal(runs.length, 1);
    assert.match(runs[0] ?? '', /Summarize @change-notes\.md/);
    assert.match(runs[0] ?? '', /git status:\n/);
    assert.match(runs[0] ?? '', /--- Context: change-notes\.md ---/);
    assert.match(runs[0] ?? '', /synthetic diff context/);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user' && message.text === '/diff Summarize @change-notes.md'), true);
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text === 'summary returned'), true);
    assert.ok(harness.output.lines.some((line) => line.includes('[codex/sdk]') && line.includes(' start')));
    assert.ok(harness.output.lines.some((line) => line.includes('[codex/sdk] idle')));
  } finally {
    await close(harness);
  }
});

test('a failed turn is logged once and the owning live session can complete the next send', async () => {
  resetVscode();
  let factoryCalls = 0;
  let runCalls = 0;
  const optionsSeen: SessionOptions[] = [];
  const harness = withFactory(async (options) => {
    factoryCalls += 1;
    optionsSeen.push(options);
    return {
      sessionId: 'round11-reused-session',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        runCalls += 1;
        if (runCalls === 1) throw new Error('synthetic turn failure');
        emit({ id: 'round11-recovered', role: 'assistant', text: 'recovered response', final: true });
      },
      async dispose() {},
    };
  });
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'first request fails' });
    const failed = harness.sidebar.controller.snapshot();
    assert.equal(failed.status, 'error');
    assert.equal(failed.busy, false);
    assert.equal(failed.messages.some((message) => message.role === 'user' && message.text === 'first request fails'), true);
    assert.equal(failed.messages.some((message) => message.role === 'error' && message.text.includes('synthetic turn failure')), true);
    assert.equal(harness.output.lines.filter((line) => line.includes('synthetic turn failure')).length, 1);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'recover on the same session' });
    const recovered = harness.sidebar.controller.snapshot();
    assert.equal(factoryCalls, 1, 'the current conversation reuses its assigned backend session after the failed turn');
    assert.equal(runCalls, 2);
    assert.equal(optionsSeen[0]?.provider, 'codex');
    assert.equal(optionsSeen[0]?.cwd, harness.workspacePath);
    assert.equal(harness.sidebar.controller.sessionId(), 'round11-reused-session');
    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.busy, false);
    assert.equal(recovered.messages.some((message) => message.role === 'assistant' && message.text === 'recovered response'), true);
    assert.equal(harness.output.lines.filter((line) => line.includes('synthetic turn failure')).length, 1, 'the same error message is not logged again on later state updates');
  } finally {
    await close(harness);
  }
});
