import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AgentsSidebar } from '../src/sidebar.js';

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
  console.log('PASS: sidebar webview loaded its script and completed the ready handshake');
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

  await send('SIMULATE_ERROR');
  assert.equal(sidebar.controller.snapshot().messages.at(-1)?.text, 'fixture backend error');
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
  await assert.rejects(
    () => sidebar.handleMessage({ type: 'restoreSession', id: 'not-the-live-session' }),
    /実行が終わってから/,
  );
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

  const models = await sidebar.listAvailableModels();
  assert.deepEqual(models.map((model) => model.id), ['fixture-model', 'fixture-second']);
  const selecting = sidebar.selectModel();
  await until(() => sidebar.isModelPickerReady());
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
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
  await config.update('codex.executablePath', mockPath, vscode.ConfigurationTarget.Global);
  await sidebar.handleMessage({ type: 'configure', backend: 'sdk' });
  await vscode.commands.executeCommand('ai-agents.showHistory');
  await until(async () => (await sidebar.probe()).history);
  const probed = await sidebar.probe();
  assert.equal(probed.history, true);
  assert.equal(typeof probed.turns, 'number');
  console.log('PASS: provider switch, history, sandbox reset, diff revert, approval token, and webview probe');

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

  await sidebar.dispose();
}
