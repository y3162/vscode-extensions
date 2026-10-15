import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ChatController } from './chat-controller.js';
import { createSession } from './providers/index.js';
import { listModels } from './providers/models.js';
import { baseModelLabel, matchesModel, selectBaseModel } from './model-selection.js';
import { ModelDetails } from './model-details.js';
import { sameModelParams } from './model-settings.js';
import { errorMessage, type AgentModel, type ChatState, type Provider, type Selection } from './types.js';

type SavedModel = Pick<Selection, 'model' | 'modelParams'> & { label: string };
interface ModelItem extends vscode.QuickPickItem { model: AgentModel }

export class AgentsSidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private webviewReady = false;
  private modelPicker?: vscode.QuickPick<ModelItem>;
  private activePickerModel?: string;
  private modelRequest?: AbortController;
  private detailsEditor?: ModelDetails;
  private detailsRequest?: AbortController;
  private readonly selectedModels: Partial<Record<Provider, SavedModel>>;
  readonly controller: ChatController;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    const config = vscode.workspace.getConfiguration('ai-agents');
    const provider = config.get<Provider>('defaultProvider', 'codex');
    this.selectedModels = context.workspaceState.get('ai-agents.selectedModels', {});
    for (const saved of Object.values(this.selectedModels)) saved.label = baseModelLabel(saved.label);
    const saved = this.selectedModels[provider];
    this.controller = new ChatController({
      provider,
      cwd: this.folders()[0]?.path ?? '',
      model: saved?.model ?? config.get<string>(`${provider}.model`, ''),
      ...(saved?.modelParams ? { modelParams: saved.modelParams } : {}),
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
      modelLabel: this.selectedModels[state.selection.provider]?.label || state.selection.model || '既定のモデル',
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
      case 'chooseModel': await this.selectModel(); return;
      case 'modelDetails': await this.configureModel(); return;
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
      || !('cwd' in message) || typeof message.cwd !== 'string') {
      throw new Error('エージェント設定が不正です。');
    }
    if (message.cwd && !this.folders().some((folder) => folder.path === message.cwd)) {
      throw new Error('作業対象のフォルダが見つかりません。');
    }
    const current = this.controller.snapshot().selection;
    const chosen = current.provider === message.provider ? current : this.selectedModels[message.provider];
    return {
      provider: message.provider, cwd: message.cwd,
      model: chosen?.model ?? vscode.workspace.getConfiguration('ai-agents').get<string>(`${message.provider}.model`, ''),
      ...(chosen?.modelParams ? { modelParams: chosen.modelParams } : {}),
    };
  }

  async listAvailableModels(selection = this.controller.snapshot().selection, signal?: AbortSignal): Promise<AgentModel[]> {
    return listModels({
      provider: selection.provider, cwd: selection.cwd || undefined, signal,
      apiKey: await this.context.secrets.get(`ai-agents.${selection.provider}.apiKey`),
      codexPath: vscode.workspace.getConfiguration('ai-agents').get<string>('codex.executablePath'),
    });
  }

  isModelPickerReady(modelId?: string): boolean {
    return Boolean(this.modelPicker && !this.modelPicker.busy && this.activePickerModel !== undefined
      && (modelId === undefined || this.activePickerModel === modelId));
  }

  async selectModel(): Promise<void> {
    if (this.detailsEditor) { this.detailsEditor.show(); return; }
    if (this.modelPicker) { this.modelPicker.show(); return; }
    const state = this.controller.snapshot();
    if (state.busy) throw new Error('実行が終わってからモデルを選択してください。');
    const selection = state.selection;
    const picker = vscode.window.createQuickPick<ModelItem>();
    this.modelPicker = picker;
    this.activePickerModel = undefined;
    picker.title = `${selection.provider === 'cursor' ? 'Cursor' : 'Codex'} のモデルを選択`;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    const refreshButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'モデル一覧を再取得' };
    picker.buttons = [refreshButton];
    const defaultItem: ModelItem = {
      label: '既定のモデル', description: 'エージェントの既定設定を使用',
      model: { id: '', label: '既定のモデル' },
    };
    const load = async () => {
      this.modelRequest?.abort();
      const request = new AbortController();
      this.modelRequest = request;
      picker.busy = true;
      picker.placeholder = 'モデル一覧を取得中…';
      picker.items = [];
      try {
        const models = await this.listAvailableModels(selection, request.signal);
        if (request.signal.aborted) return;
        picker.items = [defaultItem, ...models.map((model): ModelItem => ({
          label: model.label, description: model.isDefault ? '推奨' : undefined,
          detail: model.description,
          model,
        }))];
        picker.activeItems = [picker.items.find((item) => matchesModel(item.model, selection.model)) ?? defaultItem];
        picker.placeholder = models.length ? 'モデルを検索して選択' : 'モデルが見つかりません。再取得または既定のモデルを選択';
      } catch (error) {
        if (request.signal.aborted) return;
        picker.items = [defaultItem];
        picker.placeholder = '取得に失敗しました。右上の再取得ボタンで再試行できます';
        this.showError(new Error(`モデル一覧を取得できませんでした: ${errorMessage(error)}`));
      } finally {
        if (!request.signal.aborted) picker.busy = false;
      }
    };
    const subscriptions: vscode.Disposable[] = [];
    try {
      const chosen = await new Promise<AgentModel | undefined>((resolve) => {
        subscriptions.push(
          picker.onDidChangeActive((items) => { this.activePickerModel = items[0]?.model.id; }),
          picker.onDidAccept(() => { if (!picker.busy && picker.selectedItems[0]) resolve(picker.selectedItems[0].model); }),
          picker.onDidHide(() => resolve(undefined)),
          picker.onDidTriggerButton(() => { void load(); }),
        );
        picker.show();
        void load();
      });
      if (!chosen) return;
      const current = this.controller.snapshot().selection;
      if (current.provider !== selection.provider || current.cwd !== selection.cwd) return;
      const next = selectBaseModel(chosen, current);
      const saved: SavedModel = { model: next.model, label: chosen.label, ...(next.modelParams ? { modelParams: next.modelParams } : {}) };
      await this.controller.select(next);
      this.selectedModels[selection.provider] = saved;
      await this.context.workspaceState.update('ai-agents.selectedModels', this.selectedModels);
      this.postState();
    } finally {
      this.modelRequest?.abort();
      this.modelRequest = undefined;
      this.modelPicker = undefined;
      this.activePickerModel = undefined;
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
    }
  }

  isModelDetailsReady(id?: string): boolean { return this.detailsEditor?.isReady(id) ?? false; }

  async configureModel(): Promise<void> {
    if (this.detailsEditor) { this.detailsEditor.show(); return; }
    if (this.modelPicker) { this.modelPicker.show(); return; }
    if (this.controller.snapshot().busy) throw new Error('実行が終わってから詳細設定を変更してください。');
    if (!this.controller.snapshot().selection.model) await this.selectModel();
    const selection = this.controller.snapshot().selection;
    if (!selection.model) return;
    const editor = new ModelDetails();
    const request = new AbortController();
    this.detailsEditor = editor;
    this.detailsRequest = request;
    let model: AgentModel | undefined;
    try {
      const params = await editor.edit(selection, async () => {
        const models = await this.listAvailableModels(selection, request.signal);
        model = models.find((item) => item.id === selection.model) ?? models.find((item) => matchesModel(item, selection.model));
        return model;
      });
      if (params === undefined || !model) return;
      const current = this.controller.snapshot().selection;
      if (current.provider !== selection.provider || current.cwd !== selection.cwd || current.model !== selection.model
        || !sameModelParams(current.modelParams, selection.modelParams)) return;
      const next = { ...current, modelParams: params.length ? params : undefined };
      await this.controller.select(next);
      this.selectedModels[next.provider] = { model: next.model, modelParams: next.modelParams, label: model.label };
      await this.context.workspaceState.update('ai-agents.selectedModels', this.selectedModels);
      this.postState();
    } finally {
      request.abort();
      this.detailsEditor = undefined;
      this.detailsRequest = undefined;
    }
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

  async dispose(): Promise<void> {
    this.modelRequest?.abort();
    this.modelPicker?.hide();
    this.detailsRequest?.abort();
    this.detailsEditor?.hide();
    await this.controller.dispose();
  }

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
<div class="model-control"><span id="modelLabel">モデル</span><div class="model-buttons"><button id="model" type="button" aria-labelledby="modelLabel model" title="モデル一覧から選択">モデルを選択 ▾</button><button id="modelDetails" type="button" title="モデルの詳細設定を変更">詳細設定</button></div></div>
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
