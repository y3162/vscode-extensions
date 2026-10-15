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
  await sidebar.handleMessage({ type: 'stop' });
  await running;
  assert.equal(sidebar.controller.snapshot().busy, false);
  assert.ok(sidebar.controller.snapshot().messages.some((message) => message.text === '停止しました。'));
  await sidebar.newChat();
  assert.deepEqual(sidebar.controller.snapshot().messages, []);
  console.log('PASS: Stop terminates a running SDK subprocess; New Chat clears the conversation');

  if (process.env.AI_AGENTS_LIVE_TEST === '1') {
    await config.update('codex.executablePath', '', vscode.ConfigurationTarget.Global);
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
