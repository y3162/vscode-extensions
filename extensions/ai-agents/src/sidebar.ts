import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ChatController } from './chat-controller.js';
import { createSession } from './providers/index.js';
import { errorMessage, type ChatState, type Provider, type Selection } from './types.js';

export class AgentsSidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private webviewReady = false;
  readonly controller: ChatController;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    const config = vscode.workspace.getConfiguration('ai-agents');
    const provider = config.get<Provider>('defaultProvider', 'codex');
    this.controller = new ChatController({
      provider,
      cwd: this.folders()[0]?.path ?? '',
      model: config.get<string>(`${provider}.model`, ''),
    }, async (selection) => {
      this.requireWorkspace(selection.cwd);
      return createSession({
        ...selection,
        storagePath: join(context.globalStorageUri.fsPath, 'cursor-agents'),
        apiKey: await context.secrets.get(`ai-agents.${selection.provider}.apiKey`),
        codexPath: vscode.workspace.getConfiguration('ai-agents').get<string>('codex.executablePath'),
      });
    }, (state) => this.postState(state));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.newChat().catch((error: unknown) => this.showError(error));
    }));
  }

  private folders(): { name: string; path: string }[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
  }

  private requireWorkspace(cwd: string): void {
    if (!vscode.workspace.isTrusted) throw new Error('このフォルダを信頼してから実行してください。');
    if (!this.folders().some((folder) => folder.path === cwd)) {
      throw new Error('作業対象のフォルダをVS Codeで開いてください。');
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message).catch((error: unknown) => this.showError(error));
    });
    view.onDidDispose(() => {
      listener.dispose();
      if (this.view === view) {
        this.controller.stop();
        this.view = undefined;
        this.webviewReady = false;
      }
    });
    view.webview.html = this.html(view.webview);
  }

  isReady(): boolean { return this.webviewReady; }

  private postState(state = this.controller.snapshot()): void {
    if (!this.view || !this.webviewReady) return;
    void this.view.webview.postMessage({
      type: 'state', state, folders: this.folders(),
      models: {
        codex: vscode.workspace.getConfiguration('ai-agents').get<string>('codex.model', ''),
        cursor: vscode.workspace.getConfiguration('ai-agents').get<string>('cursor.model', 'auto'),
      },
    });
  }

  async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postState();
        return;
      case 'stop': this.controller.stop(); return;
      case 'newChat': await this.newChat(); return;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-agents'); return;
      case 'logs': this.output.show(true); return;
      case 'login':
        if (this.controller.snapshot().selection.provider === 'cursor') {
          await vscode.commands.executeCommand('ai-agents.cursorLogin');
        } else {
          const terminal = vscode.window.createTerminal('Codex Login');
          terminal.sendText('codex login');
          terminal.show();
        }
        return;
      case 'apiKey':
        await vscode.commands.executeCommand(this.controller.snapshot().selection.provider === 'cursor'
          ? 'ai-agents.setCursorApiKey' : 'ai-agents.setCodexApiKey');
        return;
      case 'select':
      case 'send': {
        const selection = this.parseSelection(message);
        await this.controller.select(selection);
        if (message.type === 'send') {
          if (!('prompt' in message) || typeof message.prompt !== 'string' || message.prompt.length > 100000) {
            throw new Error('依頼は100,000文字以内で入力してください。');
          }
          this.requireWorkspace(selection.cwd);
          this.output.appendLine(`[${selection.provider}] Start (${selection.cwd})`);
          await this.controller.send(message.prompt);
          this.output.appendLine(`[${selection.provider}] Finished`);
        }
        return;
      }
    }
  }

  private parseSelection(message: object): Selection {
    if (!('provider' in message) || (message.provider !== 'codex' && message.provider !== 'cursor')
      || !('cwd' in message) || typeof message.cwd !== 'string'
      || !('model' in message) || typeof message.model !== 'string' || message.model.length > 200) {
      throw new Error('エージェント設定が不正です。');
    }
    if (message.cwd && !this.folders().some((folder) => folder.path === message.cwd)) {
      throw new Error('作業対象のフォルダが見つかりません。');
    }
    return { provider: message.provider, cwd: message.cwd, model: message.model.trim() };
  }

  async newChat(): Promise<void> {
    await this.controller.reset();
    const state = this.controller.snapshot();
    if (!this.folders().some((folder) => folder.path === state.selection.cwd)) {
      await this.controller.select({ ...state.selection, cwd: this.folders()[0]?.path ?? '' });
    }
  }

  private showError(error: unknown): void {
    const message = errorMessage(error);
    this.output.appendLine(message);
    void this.view?.webview.postMessage({ type: 'error', text: message });
    void vscode.window.showErrorMessage(`AI Agents: ${message}`);
  }

  async dispose(): Promise<void> { await this.controller.dispose(); }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"><title>AI Agents</title>
</head><body>
<header><strong>AI Agents</strong><button id="newChat" type="button">新しい会話</button></header>
<section class="controls" aria-label="エージェント設定">
<label>エージェント<select id="provider"><option value="codex">Codex</option><option value="cursor">Cursor</option></select></label>
<label>モデル<input id="model" type="text" placeholder="既定のモデル" maxlength="200"></label>
<label class="wide">作業フォルダ<select id="folder"></select></label>
</section>
<nav><button id="login" type="button">ログイン</button><button id="apiKey" type="button">APIキー</button><button id="settings" type="button">設定</button><button id="logs" type="button">ログ</button></nav>
<main id="messages" role="log" aria-label="会話" aria-live="polite"></main>
<div id="status" role="status">準備中…</div>
<form id="composer"><label class="sr-only" for="prompt">エージェントへの依頼</label>
<textarea id="prompt" rows="4" placeholder="このフォルダについて質問、または変更を依頼…" maxlength="100000"></textarea>
<footer><small>Enterで送信 · Shift+Enterで改行</small><button id="stop" type="button" hidden>停止</button><button id="send" type="submit">送信</button></footer>
</form>
<p class="hint">選択したフォルダでファイルの変更・コマンド実行を行います。</p>
<script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body></html>`;
  }
}
