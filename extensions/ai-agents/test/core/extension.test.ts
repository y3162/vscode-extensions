import '../support/register-cursor-sdk.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../src/extension.js';
import { Cursor, cursorAuth } from '../support/cursor-sdk-stub.js';
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
  const sdk = await import('@cursor/sdk');
  assert.equal(sdk.Cursor, Cursor);
});

test('activate registers commands and deactivate is repeatable', async () => {
  resetVscode();
  cursorAuth.loginCalls.length = 0;
  cursorAuth.statusCalls = 0;
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
    for (const name of ['open', 'openSecondary', 'newChat', 'stop', 'showLogs', 'cursorLogin', 'setCursorApiKey', 'setCodexApiKey', 'diagnose', 'selectModel']) {
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
    assert.equal(cursorAuth.statusCalls, 0);
    await deactivate();
    await deactivate();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cursor login distinguishes cancellation from a real failure and never calls auth.status', async () => {
  resetVscode();
  cursorAuth.loginCalls.length = 0;
  cursorAuth.statusCalls = 0;
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-login-'));
  const context = new ExtensionContext(root);
  try {
    activate(context as never);
    window.progressCancelled = true;
    cursorAuth.loginImpl = async () => { throw new Error('login should not run'); };
    await command('ai-agents.cursorLogin')();
    assert.equal(cursorAuth.loginCalls.length, 0);
    assert.equal(window.errorMessages.length, 0);
    const options = window.progress[0]?.options as { location: number; title: string; cancellable: boolean };
    assert.equal(options.location, ProgressLocation.Notification);
    assert.equal(options.title, 'Cursorにログイン');
    assert.equal(options.cancellable, true);

    window.progressCancelled = false;
    cursorAuth.loginImpl = async () => {
      window.progress.at(-1)?.token.cancel();
      throw new Error('The operation was aborted');
    };
    await command('ai-agents.cursorLogin')();
    assert.equal(cursorAuth.loginCalls.length, 1);
    assert.equal(window.errorMessages.length, 0);

    cursorAuth.loginImpl = async () => { throw new Error('login failed token=supersecret'); };
    await command('ai-agents.cursorLogin')();
    assert.match(window.errorMessages.at(-1) ?? '', /AI Agents: login failed token=\[redacted\]/);
    assert.doesNotMatch(window.errorMessages.at(-1) ?? '', /supersecret/);

    cursorAuth.loginImpl = async (login) => { await login.openBrowser?.('https://cursor.example/login'); };
    await command('ai-agents.cursorLogin')();
    assert.equal(env.opened[0]?.fsPath, 'https://cursor.example/login');
    assert.equal(cursorAuth.loginCalls.at(-1)?.apiKeyName, 'VS Code AI Agents');
    assert.match(window.informationMessages.at(-1) ?? '', /ログインしました/);
    assert.equal(cursorAuth.statusCalls, 0);
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
