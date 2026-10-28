import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../src/extension.js';
import { commands, env, ExtensionContext, ProgressLocation, resetVscode, window, workspace } from '../support/vscode-stub.js';
import * as vscode from 'vscode';

function command(name: string): () => Promise<unknown> {
  const handler = commands.handlers.get(name);
  assert.equal(typeof handler, 'function');
  return async () => {
    await Promise.race([
      Promise.resolve(handler!()),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timed out`)), 4000)),
    ]);
  };
}

test('the vscode loader and the extension test share one module instance', async () => {
  assert.equal(vscode.window, window);
  assert.equal(vscode.commands, commands);
});

test('activate registers commands and deactivate is repeatable', async () => {
  resetVscode();
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-ext-'));
  workspace.configuration['ai-agents']!['codex.executablePath'] = '/usr/bin/false';
  workspace.configuration['ai-agents']!['cursor.agentPath'] = '/usr/bin/false';
  const context = new ExtensionContext(root);
  try {
    const { sidebar } = activate(context as never);
    assert.ok(sidebar);
    assert.equal(window.outputChannels[0]?.name, 'AI Agents');
    assert.deepEqual(window.webviewProviders.map((entry) => entry.viewId), ['ai-agents.chat', 'ai-agents.secondaryChat']);
    assert.equal((window.webviewProviders[0]?.options as { webviewOptions?: { retainContextWhenHidden?: boolean } }).webviewOptions?.retainContextWhenHidden, true);
    for (const name of ['open', 'openSecondary', 'newChat', 'stop', 'showLogs', 'setCursorApiKey', 'setCodexApiKey', 'diagnose', 'selectModel']) {
      assert.equal(typeof commands.handlers.get(`ai-agents.${name}`), 'function');
    }
    await command('ai-agents.showLogs')();
    assert.equal(window.outputChannels[0]?.shown, true);
    await command('ai-agents.stop')();
    await command('ai-agents.newChat')();
    await command('ai-agents.openSecondary')();
    assert.ok(commands.executed.some((entry) => entry.command === 'ai-agents.secondaryChat.focus'));
    commands.failures.set('ai-agents.chat.focus', () => new Error('focus token=abc123'));
    await command('ai-agents.open')();
    assert.equal(window.errorMessages.at(-1), 'AI Agents: focus token=[redacted]');
    assert.match(window.outputChannels[0]?.lines.at(-1) ?? '', /token=\[redacted\]/);
    await deactivate();
    await deactivate();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty API key deletes the secret, a trimmed key is stored, and cancel leaves secrets unchanged', async () => {
  resetVscode();
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-key-'));
  const context = new ExtensionContext(root);
  try {
    activate(context as never);
    await context.secrets.store('ai-agents.cursor.apiKey', 'existing');
    window.inputQueue.push({ value: undefined });
    await command('ai-agents.setCursorApiKey')();
    assert.equal(context.secrets.values.get('ai-agents.cursor.apiKey'), 'existing');
    assert.equal(window.informationMessages.length, 0);

    window.inputQueue.push({ value: '  sk-trim-me  ' });
    await command('ai-agents.setCursorApiKey')();
    assert.equal(context.secrets.values.get('ai-agents.cursor.apiKey'), 'sk-trim-me');
    assert.match(window.informationMessages.at(-1) ?? '', /保存しました/);

    window.inputQueue.push({ value: '   ' });
    await command('ai-agents.setCursorApiKey')();
    assert.equal(context.secrets.values.has('ai-agents.cursor.apiKey'), false);
    assert.match(window.informationMessages.at(-1) ?? '', /削除しました/);

    window.inputQueue.push({ value: '  codex-key  ' });
    await command('ai-agents.setCodexApiKey')();
    assert.equal(context.secrets.values.get('ai-agents.codex.apiKey'), 'codex-key');
    await deactivate();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
