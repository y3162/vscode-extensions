import { runReliability } from './reliability-host.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { errorMessage } from '../src/types.js';
import * as vscode from 'vscode';
import type { AgentsSidebar } from '../src/sidebar.js';
import { BackgroundTerminalViews } from '../src/background-terminal.js';

async function until(check: () => boolean | Promise<boolean>, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for extension state');
    await new Promise((done) => setTimeout(done, 50));
  }
}

export async function run(): Promise<void> {
  const cwd = process.env.AI_AGENTS_TEST_WORKSPACE!;
  const config = vscode.workspace.getConfiguration('ai-agents');
  const mockPath = join(cwd, 'mock-codex.cjs');
  await chmod(mockPath, 0o755);
  await config.update('codex.executablePath', mockPath, vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension<{ sidebar: AgentsSidebar }>('y3162.ai-agents');
  assert.ok(extension, 'Extension is discoverable');
  const manifestText = await readFile(join(extension.extensionPath, 'package.json'), 'utf8');
  const messageKeys = [...manifestText.matchAll(/"%([^"%]+)%"/g)].map((match) => match[1]!);
  for (const name of ['package.nls.json', 'package.nls.ja.json']) {
    const translations = JSON.parse(await readFile(join(extension.extensionPath, name), 'utf8')) as Record<string, string>;
    for (const key of messageKeys) assert.ok(translations[key], `${name} supplies ${key}`);
  }
  console.log('PASS: packaged translations supply all localized manifest strings');
  const { sidebar } = await extension.activate();
  await vscode.commands.executeCommand('ai-agents.open');
  await until(() => sidebar.isReady());
  if (process.env.AI_AGENTS_RELIABILITY === '1') { await runReliability(sidebar, cwd); return; }
  console.log('PASS: sidebar webview loaded its script and completed the ready handshake');
  const terminalViews = new BackgroundTerminalViews();
  let interruptedProcess = '';
  let terminated = false;
  const attached = { processId: 'native-terminal-test', itemId: 'native-item', command: 'native terminal attachment' };
  const attachmentSession = {
    async run() { throw new Error('Opening a terminal must not run a prompt'); },
    async dispose() {},
    async listBackgroundTerminals() { return [attached]; },
    async interruptBackgroundTerminal(id: string) { interruptedProcess = id; },
    async terminateBackgroundTerminal() { terminated = true; },
  };
  const nativeTerminal = terminalViews.open(attachmentSession, attached, false);
  try {
    assert.equal(terminalViews.open(attachmentSession, attached, false), nativeTerminal);
    await until(() => vscode.window.terminals.includes(nativeTerminal));
    nativeTerminal.sendText('\x03', false);
    await until(() => interruptedProcess === attached.processId);
    nativeTerminal.dispose();
    await until(() => !vscode.window.terminals.includes(nativeTerminal));
    assert.equal(terminated, false);
    console.log('PASS: integrated terminal attaches once, forwards Ctrl+C, and closing only detaches');
  } finally { terminalViews.dispose(); }
  const selection = { provider: 'codex', cwd, model: '' };
  const send = (prompt: string) => sidebar.handleMessage({ type: 'send', ...selection, prompt });
  await send('first message');
  await send('follow-up');
  const state = sidebar.controller.snapshot();
  assert.equal(state.busy, false);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 2);
  assert.ok(state.messages.some((message) => message.role === 'tool' && message.text.includes('fixture content')));
  const invocations = JSON.parse(await readFile(join(cwd, 'invocations.json'), 'utf8')) as { args: string[] }[];
  assert.ok(invocations[1]?.args.includes('resume'), 'The second turn resumes the SDK thread');
  console.log('PASS: sidebar → Codex SDK → subprocess → responses, tool output, and follow-up');

  const contextOwner = sidebar.controller;
  const preparingContext = send('/diff CONTEXT_OWNER_RACE');
  // historyReady and select() resolve first; /diff then yields to the real git subprocess.
  await Promise.resolve();
  await Promise.resolve();
  await sidebar.newChat();
  const newFront = sidebar.controller;
  assert.notEqual(newFront, contextOwner);
  await preparingContext;
  assert.ok(contextOwner.snapshot().messages.some((message) => message.role === 'user' && message.text === '/diff CONTEXT_OWNER_RACE'));
  assert.deepEqual(newFront.snapshot().messages, []);
  await sidebar.handleMessage({ type: 'restoreSession', id: contextOwner.sessionId() });
  assert.equal(sidebar.controller, contextOwner);
  console.log('PASS: switching chats during asynchronous context expansion keeps the prompt in its originating conversation');

  const linkedFile = join(cwd, 'My Project', 'README.md');
  await mkdir(join(cwd, 'My Project'));
  await writeFile(linkedFile, 'First line\nSecond line\n');
  for (const reference of [linkedFile, 'My Project/README.md', vscode.Uri.file(linkedFile).toString()]) {
    await sidebar.handleMessage({ type: 'openFile', path: reference, line: 2, column: 3 });
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.fsPath, linkedFile);
    assert.equal(editor?.selection.active.line, 1);
    assert.equal(editor?.selection.active.character, 2);
  }
  await assert.rejects(
    () => sidebar.handleMessage({ type: 'openFile', path: vscode.Uri.file(join(cwd, '..', 'outside.md')).toString() }),
    /ワークスペース外/,
  );
  console.log('PASS: absolute, relative, and encoded file URI links open the same file at the requested line and column');

  await send('SIMULATE_ERROR');
  assert.equal(sidebar.controller.snapshot().messages.at(-1)?.text, 'fixture backend error');
  const failedUser = sidebar.controller.snapshot().messages.filter((message) => message.role === 'user').at(-1)!;
  const retryReplies: unknown[] = [];
  await sidebar.handleMessage({ type: 'prepareRetry', id: failedUser.id }, {
    webview: { postMessage: async (message: unknown) => { retryReplies.push(message); return true; } },
  } as unknown as vscode.WebviewView);
  assert.ok(retryReplies.some((message: any) => message.type === 'retryPrepared' && message.id === failedUser.id
    && message.text === 'SIMULATE_ERROR' && Array.isArray(message.images)));
  assert.equal(sidebar.controller.snapshot().busy, false, 'preparing Retry must not run inference');
  await send('retry');
  assert.equal(sidebar.controller.snapshot().messages.at(-1)?.role, 'assistant');
  console.log('PASS: backend errors are shown and a new prompt can run afterward');

  const running = send('WAIT_FOR_STOP');
  await until(async () => (await readFile(join(cwd, 'invocations.json'), 'utf8')).includes('WAIT_FOR_STOP'));
  await sidebar.handleMessage({ type: 'enqueue', ...selection, prompt: 'queued follow-up' });
  assert.equal(sidebar.controller.snapshot().queue.length, 1);
  const liveId = sidebar.controller.sessionId();
  if (liveId) {
    await sidebar.handleMessage({ type: 'restoreSession', id: liveId });
    assert.equal(sidebar.controller.snapshot().busy, true);
  }
  await sidebar.handleMessage({ type: 'restoreSession', id: 'not-the-live-session' });
  assert.equal(sidebar.controller.snapshot().busy, true);
  assert.equal(sidebar.controller.snapshot().queue.length, 1);
  await sidebar.handleMessage({ type: 'stop' });
  await running;
  assert.equal(sidebar.controller.snapshot().busy, false);
  assert.equal(sidebar.controller.snapshot().queue.length, 1);
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text === '停止しました。'));
  const queuedId = sidebar.controller.snapshot().queue[0]?.id;
  assert.ok(queuedId);
  await sidebar.handleMessage({ type: 'sendNow', id: queuedId });
  assert.equal(sidebar.controller.snapshot().queue.length, 0);
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text.includes('queued follow-up')));
  await sidebar.newChat();
  assert.deepEqual(sidebar.controller.snapshot().messages, []);
  console.log('PASS: Stop terminates a running SDK subprocess; a queued prompt survives Stop and can be sent; New Chat clears the conversation');

  const background = send('WAIT_FOR_STOP');
  await until(() => sidebar.controller.snapshot().busy && Boolean(sidebar.controller.sessionId()));
  const backgroundId = sidebar.controller.sessionId();
  assert.ok(backgroundId);
  await sidebar.newChat();
  const foregroundBeforeStale = sidebar.controller.snapshot();
  await sidebar.handleMessage({ type: 'sendNow', conversationId: 'missing-conversation', id: 'missing' });
  await sidebar.handleMessage({ type: 'stop', conversationId: 'missing-conversation' });
  await sidebar.handleMessage({ type: 'buildPlan', conversationId: 'missing-conversation', planId: 'stale', revision: 1 });
  assert.deepEqual(sidebar.controller.snapshot(), foregroundBeforeStale);
  assert.equal(sidebar.controller.snapshot().busy, false);
  assert.notEqual(sidebar.controller.sessionId(), backgroundId);
  await sidebar.handleMessage({ type: 'restoreSession', id: backgroundId });
  assert.equal(sidebar.controller.sessionId(), backgroundId);
  assert.equal(sidebar.controller.snapshot().busy, true);
  await sidebar.handleMessage({ type: 'stop' });
  await background;
  assert.equal(sidebar.controller.snapshot().busy, false);
  console.log('PASS: a running chat stays reachable after New Chat and can be stopped from the restored view');



  const models = await sidebar.listAvailableModels();
  assert.deepEqual(models.map((model) => model.id), ['fixture-model', 'fixture-second']);
  const selecting = sidebar.selectModel();
  await until(() => sidebar.isModelPickerReady('fixture-model'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await selecting;
  assert.equal(sidebar.controller.snapshot().selection.model, 'fixture-model');
  await send('use the selected model');
  const selectedInvocations = JSON.parse(await readFile(join(cwd, 'invocations.json'), 'utf8')) as { args: string[] }[];
  const selectedArgs = selectedInvocations.at(-1)!.args;
  assert.equal(selectedArgs[selectedArgs.indexOf('--model') + 1], 'fixture-model');
  console.log('PASS: models are discovered, chosen in the native picker, and passed to the SDK');

  const beforeCancel = sidebar.controller.snapshot();
  const cancelledPicker = sidebar.selectModel();
  await until(() => sidebar.isModelPickerReady());
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await cancelledPicker;
  assert.deepEqual(sidebar.controller.snapshot(), beforeCancel);
  console.log('PASS: cancelling the model picker preserves the active conversation and selection');

  const detailSettings = [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }];
  await sidebar.controller.select({ ...sidebar.controller.snapshot().selection, modelParams: detailSettings });
  await send('preserve these settings');
  const beforeReselect = sidebar.controller.snapshot();
  const reselecting = sidebar.selectModel();
  await until(() => sidebar.isModelPickerReady());
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await reselecting;
  assert.deepEqual(sidebar.controller.snapshot(), beforeReselect);
  console.log('PASS: reselecting the base model preserves effort/context settings and conversation');

  const configuring = sidebar.configureModel();
  await until(() => sidebar.isModelDetailsReady('parameter:modelReasoningEffort'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => sidebar.isModelDetailsReady('default:modelReasoningEffort'));
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await until(() => sidebar.isModelDetailsReady('value:modelReasoningEffort:low'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => sidebar.isModelDetailsReady('parameter:modelReasoningEffort'));
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await until(() => sidebar.isModelDetailsReady('apply'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await configuring;
  assert.deepEqual(sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'low' }]);
  assert.deepEqual(sidebar.controller.snapshot().messages, []);
  const beforeUnsupported = sidebar.controller.snapshot().selection;
  await sidebar.handleMessage({ type: 'setModelParam', id: 'context', value: '1m' });
  assert.deepEqual(sidebar.controller.snapshot().selection, beforeUnsupported);
  await sidebar.handleMessage({ type: 'setModelParam', id: 'modelReasoningEffort', value: 'medium' });
  assert.deepEqual(sidebar.controller.snapshot().selection.modelParams, [{ id: 'modelReasoningEffort', value: 'medium' }]);
  await send('use the configured effort');
  const configured = JSON.parse(await readFile(join(cwd, 'invocations.json'), 'utf8')) as { args: string[] }[];
  assert.ok(configured.at(-1)!.args.some((arg) => arg.includes('model_reasoning_effort') && arg.includes('medium')));
  console.log('PASS: detail changes apply atomically and Codex SDK forwards the selected effort');

  const beforeDetailsCancel = sidebar.controller.snapshot();
  const cancellingDetails = sidebar.configureModel();
  await until(() => sidebar.isModelDetailsReady('parameter:modelReasoningEffort'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => sidebar.isModelDetailsReady('value:modelReasoningEffort:medium'));
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await until(() => sidebar.isModelDetailsReady('value:modelReasoningEffort:high'));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await until(() => sidebar.isModelDetailsReady('parameter:modelReasoningEffort'));
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await cancellingDetails;
  assert.deepEqual(sidebar.controller.snapshot(), beforeDetailsCancel);
  console.log('PASS: cancelling detail edits preserves settings and conversation');

  await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd, model: '' });
  assert.equal(sidebar.controller.snapshot().selection.provider, 'cursor');
  await sidebar.handleMessage({ type: 'select', provider: 'codex', cwd, model: '' });
  assert.equal(sidebar.controller.snapshot().selection.provider, 'codex');
  await send('history row');
  await sidebar.handleMessage({ type: 'refreshSessions' });
  const sessionId = sidebar.controller.snapshot().sessions[0]?.id;
  assert.ok(sessionId);
  await sidebar.newChat();
  await sidebar.handleMessage({ type: 'restoreSession', id: sessionId });
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('再開') || message.text.includes('resumed') || message.role === 'assistant'));
  await sidebar.handleMessage({ type: 'configure', sandbox: 'read-only' });
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('新しい会話') || message.text.includes('new conversation')));
  assert.equal(sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false);
  const note = join(cwd, 'note.txt');
  await writeFile(note, 'changed\n');
  await send(`EMIT_DIFF ${note}`);
  assert.equal(sidebar.controller.snapshot().changes.some((change) => change.path === note && change.previousText === 'original\n'), true);
  await sidebar.handleMessage({ type: 'openDiff', path: note });
  assert.ok(vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.label.includes('note.txt')));
  await sidebar.handleMessage({ type: 'revertFile', path: note });
  assert.equal(await readFile(note, 'utf8'), 'original\n');
  const appServer = join(cwd, 'mock-app-server.cjs');
  await chmod(appServer, 0o755);
  await config.update('codex.executablePath', appServer, vscode.ConfigurationTarget.Global);
  await sidebar.handleMessage({ type: 'configure', backend: 'app-server' });
  const approving = send('NEED_APPROVAL');
  await until(() => sidebar.controller.snapshot().pendingPermission?.title === 'npm test');
  const token = sidebar.controller.interactionTokens().permission;
  assert.ok(token);
  await sidebar.handleMessage({ type: 'resolvePermission', id: sidebar.controller.snapshot().pendingPermission?.id, decision: 'allow-once', token });
  await approving;
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text.includes('approved:accept')));
  const terminalOwner = sidebar.controller;
  await send('BACKGROUND');
  assert.equal(terminalOwner.snapshot().terminals.length, 1);
  const terminalSession = terminalOwner.sessionId();
  await sidebar.newChat();
  assert.notEqual(sidebar.controller, terminalOwner, 'New Chat must retain an idle parent with a live terminal');
  await sidebar.handleMessage({ type: 'restoreSession', id: terminalSession });
  assert.equal(sidebar.controller, terminalOwner);
  await until(() => terminalOwner.snapshot().terminals.length === 0);
  assert.ok(terminalOwner.snapshot().messages.some((message) => message.tool?.exitCode === 0 && message.text.includes('stdout done')));
  await config.update('codex.executablePath', mockPath, vscode.ConfigurationTarget.Global);
  await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
  await vscode.commands.executeCommand('ai-agents.showHistory');
  await until(async () => (await sidebar.probe()).history);
  const probed = await sidebar.probe();
  assert.equal(probed.history, true);
  assert.equal(typeof probed.turns, 'number');
  console.log('PASS: provider switch, history, sandbox reset, diff revert, approval token, and webview probe');

  assert.equal(config.get<number>('maxBackgroundSessions', 3), 3);
  await config.update('maxBackgroundSessions', 1, vscode.ConfigurationTarget.Global);
  const limitedController = sidebar.controller;
  const limited = send('WAIT_FOR_STOP');
  await until(() => limitedController.snapshot().busy && Boolean(limitedController.sessionId()));
  try {
    await sidebar.newChat();
    await assert.rejects(send('must not execute'), /上限/);
    assert.equal(sidebar.controller.snapshot().busy, false);
    assert.equal(limitedController.snapshot().busy, true);
  } finally {
    limitedController.stop();
    await limited;
    await config.update('maxBackgroundSessions', undefined, vscode.ConfigurationTarget.Global);
  }
  console.log('PASS: default concurrency is 3; reaching the configured limit blocks a new run without stopping another conversation');

  if (process.env.AI_AGENTS_LIVE_MODELS_TEST === '1') {
    await config.update('codex.executablePath', '', vscode.ConfigurationTarget.Global);
    const liveModels = await sidebar.listAvailableModels();
    assert.ok(liveModels.length > 0);
    assert.ok(liveModels.every((model) => model.id && model.label));
    console.log(`PASS: bundled Codex app-server discovered ${liveModels.length} models inside the extension host`);
    await config.update('codex.executablePath', mockPath, vscode.ConfigurationTarget.Global);
  }

  if (process.env.AI_AGENTS_LIVE_CURSOR_MODELS_TEST === '1') {
    const cursorModels = await sidebar.listAvailableModels({ provider: 'cursor', cwd, model: '' });
    assert.ok(cursorModels.length > 0);
    assert.equal(cursorModels.length, new Set(cursorModels.map((model) => model.id)).size);
    assert.ok(cursorModels.every((model) => !model.label.includes(' — ')));
    console.log(`PASS: Cursor discovery returned ${cursorModels.length} base models with detail metadata kept separate`);
  }

  if (process.env.AI_AGENTS_LIVE_TEST === '1') {
    await config.update('codex.executablePath', '', vscode.ConfigurationTarget.Global);
    await sidebar.newChat();
    await sidebar.controller.select({ provider: 'codex', cwd, model: '' });
    await writeFile(join(cwd, 'live-input.txt'), 'AI_AGENTS_LIVE_OK\n');
    const live = send('Read live-input.txt in the current working directory. Create live-output.txt containing exactly the same text. Do not inspect other files or run other tasks. Reply with that text.');
    const timer = setTimeout(() => sidebar.controller.stop(), 90000);
    try {
      await live;
      assert.equal(await readFile(join(cwd, 'live-output.txt'), 'utf8'), 'AI_AGENTS_LIVE_OK\n');
      assert.ok(sidebar.controller.snapshot().messages.some((message) => message.role === 'assistant' && message.text.includes('AI_AGENTS_LIVE_OK')));
      console.log('PASS: live Codex agent read and wrote workspace files through the extension');
    } finally { clearTimeout(timer); }
  }

  if (process.env.AI_AGENTS_LIVE_RUNTIME === '1') {
    const { Agent, JsonlLocalAgentStore } = createRequire(join(extension.extensionPath, 'package.json'))('@cursor/sdk') as typeof import('@cursor/sdk');
    const agent = await Agent.create({ model: { id: 'composer-2.5' }, local: { cwd, store: new JsonlLocalAgentStore(join(cwd, 'sdk-host-store')), sandboxOptions: { enabled: true }, settingSources: [] } });
    try {
      const run = await agent.send('Explicit verification: use Task to launch two independent children concurrently. Each child must run a shell command printing its name, sleeping 3 seconds, then printing done. No file changes. Return actual results. Do not simulate children.');
      const deadline = setTimeout(() => { void run.cancel(); }, 90000);
      try {
        const tasks: { id: string; status: string }[] = [];
        for await (const event of run.stream()) if (event.type === 'tool_call' && event.name.toLowerCase() === 'task') tasks.push({ id: event.call_id, status: event.status });
        const result = await run.wait();
        console.log('SDK_HOST_RUNTIME', JSON.stringify({ node: process.versions.node, status: result.status, error: result.error ? errorMessage(new Error(result.error.message)) : undefined, tasks }));
      } finally { clearTimeout(deadline); }
    } catch (error) { console.log('SDK_HOST_LIMITATION', process.versions.node, errorMessage(error)); }
    finally { await agent[Symbol.asyncDispose](); }
  }

  if (process.env.AI_AGENTS_TERMINAL_UI_HOLD === '1') {
    await sidebar.newChat();
    await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd });
    await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
    await sidebar.handleMessage({ type: 'setModel', modelId: 'composer-2.5' });
    await sidebar.openPanel('chat');
    await sidebar.handleMessage({ type: 'send', provider: 'cursor', cwd, prompt: 'Use the Shell tool native background mode with block_until_ms 0 to run exactly: python3 -u -c \'import time; print("TERMINAL_UI_READY",flush=True); time.sleep(45)\'. Do not use & or nohup. Return immediately, do not poll or wait. No file changes.' });
    assert.ok(sidebar.controller.snapshot().terminals.length);
    console.log('TERMINAL_GUI_READY', JSON.stringify(sidebar.controller.snapshot().terminals.map(({ command, status }) => ({ command, status }))));
    await new Promise((resolve) => setTimeout(resolve, 55000));
  }

  if (process.env.AI_AGENTS_UI_HOLD === '1') {
    execFileSync('git', ['init', '-q'], { cwd });
    await config.update('codex.executablePath', '', vscode.ConfigurationTarget.Global);
    await sidebar.handleMessage({ type: 'configure', backend: 'app-server', mode: 'plan', sandbox: 'workspace-write', approval: 'never' });
    await sidebar.handleMessage({ type: 'loadModelCatalog', refresh: true, requestId: 990 });
    await sidebar.handleMessage({ type: 'setModel', modelId: 'gpt-6-luna' });
    await sidebar.controller.send('Create a concise plan to change note.txt to hello followed by a newline. Do not edit or implement. Stop after the plan.');
    await vscode.commands.executeCommand('ai-agents.open');
    console.log('UI_HOST_READY', cwd);
    await until(async () => { try { await readFile(join(cwd, 'ui-done')); return true; } catch { return false; } }, 1200000);
  }
  if (process.env.AI_AGENTS_GUI_MOCK_HOLD === '1') {
    await sidebar.newChat();
    await sidebar.handleMessage({ type: 'select', provider: 'codex', cwd });
    await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
    await send('GUI fixture: 日本語 copy and session restore');
    await sidebar.openPanel('chat');
    const clipboardBefore = await vscode.env.clipboard.readText();
    try {
      await sidebar.handleMessage({ type: 'copy', requestId: 'gui-clipboard', text: 'GUI clipboard 日本語 😀' });
      assert.equal(await vscode.env.clipboard.readText(), 'GUI clipboard 日本語 😀');
      console.log('PASS: Extension Host copy writes Unicode text to the real OS clipboard');
    } finally { await vscode.env.clipboard.writeText(clipboardBefore); }
    console.log('GUI_MOCK_READY', cwd);
    await until(async () => { try { await readFile(join(cwd, 'ui-done')); return true; } catch { return false; } }, 1200000);
  }
  await sidebar.dispose();
}
