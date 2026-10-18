import '../support/register-cursor-sdk.mjs';

import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { mock, test } from 'node:test';

import { activate, deactivate } from '../../src/extension.js';

import { commands, ExtensionContext, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

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
});;
