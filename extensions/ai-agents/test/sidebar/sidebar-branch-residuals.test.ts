import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { AgentsSidebar } from '../../src/sidebar.js';
import type { AgentModel, AgentSession, Selection } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';
import { resetVscode, window } from '../support/vscode-stub.js';
import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('saved model labels migrate to their base name while selection parameters are restored', async () => {
  resetVscode();
  const paths = prepareHarnessRoot();
  await paths.context.workspaceState.update('ai-agents.selectedModels', {
    codex: {
      model: 'gpt-synthetic', label: 'GPT Synthetic — High 1M', hasDetails: true,
      modelParams: [{ id: 'modelReasoningEffort', value: 'high' }],
    },
    cursor: { model: 'auto', label: 'Cursor — Fast', hasDetails: false },
  });
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, (async () => ({
    sessionId: 'saved-model', async run() {}, async dispose() {},
  })) as never);
  const harness: Harness = { ...paths, sidebar, output };
  const view = createView();
  try {
    assert.equal(sidebar.controller.snapshot().selection.model, 'gpt-synthetic');
    assert.deepEqual(sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'high' }]);
    sidebar.resolveWebviewView(view as never);
    await sidebar.handleMessage({ type: 'ready' }, view as never);
    const state = view.messages.filter((message) => message.type === 'state').at(-1) as { shell?: { modelLabel?: string; effortLabel?: string | null } } | undefined;
    assert.equal(state?.shell?.modelLabel, 'GPT Synthetic');
    assert.match(state?.shell?.effortLabel ?? '', /high/i);
    assert.equal(paths.context.workspaceState.get<Record<string, { label: string }>>('ai-agents.selectedModels')?.cursor?.label, 'Cursor');
  } finally {
    await close(harness);
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('malformed webview messages with missing or invalid fields have no side effects', async () => {
  resetVscode();
  const harness = openSidebar();
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.context.workspaceState.update('ai-agents.dismissedWarning', 'keep-warning');
    const before = harness.sidebar.controller.snapshot();
    const posted = view.messages.length;

    await harness.sidebar.handleMessage(null, view as never);
    await harness.sidebar.handleMessage('invalid payload', view as never);
    await harness.sidebar.handleMessage({}, view as never);
    await harness.sidebar.handleMessage({ type: 'dismissWarning' }, view as never);
    await harness.sidebar.handleMessage({ type: 'dismissWarning', id: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'removeDirectory', path: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'probeResult', turns: '0', pending: false, history: false, settings: false }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry' }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 7 }, view as never);
    await harness.sidebar.handleMessage({ type: 'prepareRetry', id: 'missing-user-id' }, view as never);

    assert.deepEqual(harness.sidebar.controller.snapshot(), before);
    assert.equal(harness.context.workspaceState.get('ai-agents.dismissedWarning'), 'keep-warning');
    assert.equal(view.messages.length, posted, 'invalid payloads do not post a retry or altered state');
  } finally {
    await close(harness);
  }
});

test('disposing a Sidebar aborts an in-flight model picker request and closes its picker', async () => {
  resetVscode();
  const harness = openSidebar();
  const entered = deferred<AbortSignal>();
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    entered.resolve(signal!);
    return new Promise<AgentModel[]>(() => {});
  };
  const select = harness.sidebar.selectModel();
  let signal!: AbortSignal;
  try {
    signal = await entered.promise;
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.busy, true);
    await harness.sidebar.dispose();
    await select;

    assert.equal(signal.aborted, true);
    assert.equal(picker.shown, false);
    assert.equal(picker.disposed, true);
    assert.equal(harness.sidebar.controller.snapshot().selection.model, '');
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('disposing a Sidebar aborts a model-details load without applying a partial selection', async () => {
  resetVscode();
  const harness = openSidebar();
  const model: AgentModel = {
    id: 'details-dispose-model', label: 'Details model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
  };
  const selection: Selection = { provider: 'codex', cwd: harness.workspacePath, model: model.id };
  const entered = deferred<AbortSignal>();
  harness.sidebar.listAvailableModels = async (_selection, signal) => {
    entered.resolve(signal!);
    return new Promise<AgentModel[]>(() => {});
  };
  await harness.sidebar.controller.select(selection);
  const editing = harness.sidebar.configureModel();
  try {
    const signal = await entered.promise;
    const picker = window.quickPicks.at(-1)!;
    assert.equal(picker.shown, true);
    assert.equal(picker.busy, true);
    await harness.sidebar.dispose();
    await editing;

    assert.equal(signal.aborted, true);
    assert.equal(picker.shown, false);
    assert.equal(picker.disposed, true);
    assert.deepEqual(harness.sidebar.controller.snapshot().selection, selection);
    assert.equal(harness.context.workspaceState.get<Record<string, { model: string }>>('ai-agents.selectedModels')?.codex, undefined);
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});

test('disposing a Sidebar during a run cancels the deferred state flush and leaves the active session stopped', async () => {
  resetVscode();
  const entered = deferred<void>();
  const harness = withSession(async () => ({
    sessionId: 'dispose-running-session',
    async run(_prompt, signal) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
      });
    },
    async dispose() {},
  }));
  try {
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'held request' });
    await entered.promise;
    assert.equal(harness.sidebar.controller.snapshot().busy, true);
    await harness.sidebar.dispose();
    await sending;

    const state = harness.sidebar.controller.snapshot();
    assert.equal(state.busy, false);
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.messages, []);
    assert.equal(harness.sidebar.controller.hasSession(), false);
  } finally {
    await close(harness);
  }
});

test('usage and instruction inspectors retain readable SDK errors instead of rejecting the webview request', async () => {
  resetVscode();
  const harness = withSession(async () => ({
    sessionId: 'inspector-errors',
    async run() {},
    async rateLimits() { throw new Error('synthetic rate limits failure'); },
    async instructions() { throw new Error('synthetic instructions failure'); },
    async dispose() {},
  }));
  const view = createView();
  try {
    harness.sidebar.resolveWebviewView(view as never);
    await harness.sidebar.handleMessage({ type: 'ready' }, view as never);
    await harness.sidebar.controller.openSession();
    await harness.sidebar.handleMessage({ type: 'usage' });
    await harness.sidebar.handleMessage({ type: 'instructions' });
    const inspectors = view.messages.filter((message) => message.type === 'inspector');
    assert.match(String(inspectors.find((message) => message.title === 'Usage')?.text), /synthetic rate limits failure/);
    assert.match(String(inspectors.find((message) => message.title === 'Rules \/ Skills \/ MCP')?.text), /synthetic instructions failure/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'codex');
    assert.equal(window.errorMessages.length, 0);
  } finally {
    await close(harness);
  }
});
