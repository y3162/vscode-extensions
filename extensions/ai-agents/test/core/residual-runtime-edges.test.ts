import '../support/register-cursor-sdk.mjs';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { activate, deactivate } from '../../src/extension.js';
import { ModelDetails } from '../../src/model-details.js';
import { codexTool } from '../../src/providers/tools.js';
import { StdioJsonRpc } from '../../src/providers/stdio-rpc.js';
import { instructionSummary, searchWorkspace, workspaceCommands } from '../../src/vscode-context.js';
import { commands, ExtensionContext, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';
import { settle } from '../support/vscode-harness.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function command(name: string): Promise<unknown> {
  const handler = commands.handlers.get(name);
  assert.equal(typeof handler, 'function', `missing registered command ${name}`);
  return await handler!();
}

test('extension commands route to their sidebar actions and report action failures', async () => {
  resetVscode();
  const root = tempDir('ai-agents-command-routing-');
  const context = new ExtensionContext(root);
  try {
    workspace.configuration['ai-agents']!['codex.executablePath'] = '/usr/bin/false';
    workspace.configuration['ai-agents']!['cursor.agentPath'] = '/usr/bin/false';
    const { sidebar } = activate(context as never);
    const calls: string[] = [];
    for (const name of ['newChat', 'stop', 'openPanel', 'signIn', 'showUsage', 'showInstructions', 'setApiKey', 'insertContext', 'showDiagnostics', 'selectModel', 'configureModel']) {
      Object.defineProperty(sidebar, name, {
        configurable: true,
        value: async (...args: unknown[]) => { calls.push(`${name}${args.length ? `:${args.join(',')}` : ''}`); },
      });
    }

    for (const name of [
      'open', 'openSecondary', 'newChat', 'stop', 'showHistory', 'showSettings', 'signIn', 'usage',
      'instructions', 'apiKey', 'addSelection', 'addFile', 'diagnose', 'selectModel', 'configureModel', 'showLogs',
      'setCursorApiKey', 'setCodexApiKey',
    ]) await command(`ai-agents.${name}`);

    assert.deepEqual(calls, [
      'newChat', 'openPanel:chat', 'stop', 'openPanel:history', 'openPanel:settings', 'signIn', 'showUsage',
      'showInstructions', 'setApiKey', 'insertContext:selection', 'insertContext:file', 'showDiagnostics',
      'selectModel', 'configureModel',
    ]);
    assert.deepEqual(commands.executed, [
      { command: 'ai-agents.chat.focus', args: [] },
      { command: 'ai-agents.secondaryChat.focus', args: [] },
    ]);
    assert.equal(window.outputChannels[0]?.shown, true);

    Object.defineProperty(sidebar, 'showUsage', {
      configurable: true,
      value: async () => { throw new Error('usage failed token=route-secret'); },
    });
    await command('ai-agents.usage');
    assert.equal(window.errorMessages.at(-1), 'AI Agents: usage failed token=[redacted]');
    assert.doesNotMatch(window.outputChannels[0]?.lines.at(-1) ?? '', /route-secret/);
    assert.match(window.outputChannels[0]?.lines.at(-1) ?? '', /token=\[redacted\]/);
  } finally {
    await deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex MCP failures retain failed status in tool metadata', () => {
  assert.deepEqual(codexTool({
    id: 'mcp-error', type: 'mcp_tool_call', status: 'completed', server: 'docs', tool: 'search',
    arguments: {}, error: { message: 'permission denied' },
  }), { kind: 'mcp', name: 'docs/search', status: 'error', target: 'search' });
});

test('stdio RPC rejects children that do not expose both pipes', () => {
  for (const missing of ['stdout', 'stdin'] as const) {
    const child = Object.assign(new EventEmitter(), {
      stdin: missing === 'stdin' ? undefined : new PassThrough(),
      stdout: missing === 'stdout' ? undefined : new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawn = mock.method(childProcess, 'spawn', () => child as unknown as ChildProcess);
    try {
      assert.throws(() => new StdioJsonRpc({ command: 'agent', args: [] }), /did not expose stdio/);
    } finally {
      spawn.mock.restore();
    }
  }
});

test('workspace search applies exact, prefix, substring, and fallback ranking', async () => {
  resetVscode();
  const cwd = tempDir('ai-agents-search-rank-');
  try {
    workspace.findFilesResult = ['app.ts', 'apple.ts', 'mapple.ts', 'zebra.ts']
      .map((name) => Uri.file(path.join(cwd, 'src', name)));
    const results = await searchWorkspace(cwd, 'app');
    assert.deepEqual(results.slice(0, 3).map((item) => item.label), ['app.ts', 'apple.ts', 'mapple.ts']);
    assert.equal(results.find((item) => item.token === 'src')?.label, 'src');
    assert.ok(results.findIndex((item) => item.token === 'src') > 2);
    assert.ok(results.findIndex((item) => item.label === 'zebra.ts') > 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace command cache remains valid until the 30 second boundary, then refreshes', async (t) => {
  resetVscode();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const cwd = tempDir('ai-agents-command-cache-');
  const commandDir = path.join(cwd, '.cursor', 'commands');
  const file = path.join(commandDir, 'refresh.md');
  const name = `Refresh${path.basename(cwd).replace(/[^a-z0-9]/gi, '')}`;
  try {
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(file, `---\nname: ${name}\ndescription: first\n---\ninitial`);
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'first');
    writeFileSync(file, `---\nname: ${name}\ndescription: second\n---\nupdated`);
    now += 29_999;
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'first');
    now += 1;
    assert.equal((await workspaceCommands(cwd)).find((item) => item.name === name)?.description, 'second');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('instruction summary handles absent local rules and files', async () => {
  const cwd = tempDir('ai-agents-instructions-missing-');
  try {
    writeFileSync(path.join(cwd, 'AGENTS.md'), '# local rules');
    const summary = await instructionSummary(cwd);
    assert.match(summary, /AGENTS\.md/);
    assert.doesNotMatch(summary, /CLAUDE\.md|\.cursorrules|\.cursor\/rules:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('model details show an SDK default that is missing from its advertised values', async () => {
  resetVscode();
  const inconsistent = {
    id: 'gpt-edge', label: 'Edge model',
    parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
    defaultParams: [{ id: 'effort', value: 'future-value' }],
  };
  const details = new ModelDetails();
  const pending = details.edit({ provider: 'cursor', cwd: '/work', model: 'gpt-edge' }, async () => inconsistent);
  const picker = window.quickPicks.at(-1) as unknown as {
    items: Array<{ id: string; description?: string }>;
    selectedItems: object[];
    activeItems: Array<{ id: string }>;
    accept(): void;
    hide(): void;
  } | undefined;
  assert.ok(picker);
  await settle();
  const parameterItem = picker.items.find((item) => item.id === 'parameter:effort') as { description?: string } | undefined;
  assert.equal(parameterItem?.description, 'future-value');
  picker.selectedItems = [parameterItem as object];
  picker.accept();
  assert.equal(picker.activeItems[0]?.id, 'default:effort');
  picker.hide();
  assert.equal(await pending, undefined);
});
