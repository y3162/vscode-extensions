import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from './capabilities.js';
import { revertChange } from './change-review.js';
import { ChatController } from './chat-controller.js';
import { builtinCommand, expandPrompt } from './context-text.js';
import { runProcess } from './diagnostics.js';
import { localeFrom } from './i18n.js';
import { sanitizeImages } from './images.js';
import { baseModelLabel, matchesModel, selectBaseModel } from './model-selection.js';
import { ModelDetails } from './model-details.js';
import { sameModelParams } from './model-settings.js';
import { createSession, listCursorSdkSessions, writeBaselineFile } from './providers/index.js';
import { listModels } from './providers/models.js';
import { upsertSession } from './session-index.js';
import { errorMessage, type AgentMode, type AgentModel, type Backend, type ChatState, type ImageAttachment, type Provider, type Selection, type SessionSummary } from './types.js';
import { activeFileToken, gitSummary, instructionSummary, problemsText, recentTerminalText, searchWorkspace, selectionBlock, watchTerminals, workspaceCommands } from './vscode-context.js';

type SavedModel = Pick<Selection, 'model' | 'modelParams'> & { label: string };
interface ModelItem extends vscode.QuickPickItem { model: AgentModel }

export class AgentsSidebar implements vscode.WebviewViewProvider {
  private readonly views = new Set<vscode.WebviewView>();
  private readonly readyViews = new Set<vscode.WebviewView>();
  private readonly controls: Record<Provider, AgentControls>;
  private readonly locale = localeFrom(vscode.env.language);
  private resumeId?: string;
  private lastBusy = false;
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
    const storedControls = context.workspaceState.get<Partial<Record<Provider, AgentControls>>>('ai-agents.controls', {});
    this.controls = {
      codex: normalizeControls('codex', { ...defaultControls('codex', config.get<Backend>('codex.backend', 'sdk')), ...storedControls.codex }),
      cursor: normalizeControls('cursor', { ...defaultControls('cursor', config.get<Backend>('cursor.backend', 'sdk')), ...storedControls.cursor }),
    };
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
      const controls = this.controls[selection.provider];
      return createSession({
        ...selection,
        ...controls,
        storagePath: path.join(context.globalStorageUri.fsPath, 'cursor-agents'),
        apiKey: await context.secrets.get(`ai-agents.${selection.provider}.apiKey`),
        codexPath: vscode.workspace.getConfiguration('ai-agents').get<string>('codex.executablePath'),
        agentPath: vscode.workspace.getConfiguration('ai-agents').get<string>('cursor.agentPath') || 'agent',
        resumeId: this.resumeId,
        interactions: this.controller.interactions,
        onIdentity: (summary) => this.remember(summary),
      });
    }, (state) => this.postState(state));
    this.controller.setAutoApprove(config.get<boolean>('autoApprove', false) === true);
    this.controller.replaceSessions(context.workspaceState.get<SessionSummary[]>('ai-agents.sessionIndex', []));
    watchTerminals(context.subscriptions);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('ai-agents.autoApprove')) return;
      this.controller.setAutoApprove(vscode.workspace.getConfiguration('ai-agents').get<boolean>('autoApprove', false) === true);
    }));
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
    this.views.add(view);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message, view).catch((error: unknown) => this.showError(error));
    });
    view.onDidDispose(() => {
      listener.dispose();
      this.views.delete(view);
      this.readyViews.delete(view);
    });
    view.webview.html = this.html(view.webview);
  }

  isReady(): boolean { return this.readyViews.size > 0; }

  private post(message: unknown): void {
    for (const view of this.readyViews) void view.webview.postMessage(message);
  }

  private postState(state = this.controller.snapshot()): void {
    if (!this.readyViews.size) return;
    if (state.busy !== this.lastBusy) {
      this.lastBusy = state.busy;
      void vscode.commands.executeCommand('setContext', 'ai-agents.busy', state.busy);
    }
    const controls = this.controls[state.selection.provider];
    this.post({
      type: 'state',
      state: {
        ...state,
        changes: state.changes.map((change) => ({
          path: change.path, kind: change.kind, additions: change.additions, deletions: change.deletions,
          canRevert: change.previousText !== undefined || Boolean(change.diff),
        })),
        queue: state.queue.map((item) => ({ id: item.id, text: item.extras?.displayText || item.text, images: item.extras?.images?.length ?? 0 })),
      },
      folders: this.folders(),
      modelLabel: this.selectedModels[state.selection.provider]?.label || state.selection.model || '既定のモデル',
      capabilities: capabilitiesFor(state.selection.provider, controls.backend),
      controls,
      locale: this.locale,
    });
  }

  async handleMessage(message: unknown, source?: vscode.WebviewView): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    switch (message.type) {
      case 'ready':
        if (source) this.readyViews.add(source);
        this.postState();
        return;
      case 'stop': this.controller.stop(); return;
      case 'newChat': await this.newChat(); return;
      case 'chooseModel': await this.selectModel(); return;
      case 'modelDetails': await this.configureModel(); return;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-agents'); return;
      case 'logs': this.output.show(true); return;
      case 'diagnose': await this.showDiagnostics(); return;
      case 'usage': await this.showUsage(); return;
      case 'instructions': await this.showInstructions(); return;
      case 'toggleAutoApprove': await this.toggleAutoApprove(); return;
      case 'refreshSessions': await this.refreshSessions(); return;
      case 'configure': await this.configure(message); return;
      case 'suggest': await this.suggest(message); return;
      case 'attach': {
        const kind = 'kind' in message ? message.kind : undefined;
        await this.insertContext(kind === 'selection' || kind === 'problems' || kind === 'git' || kind === 'terminal' ? kind : 'file');
        return;
      }
      case 'sendNow': if ('id' in message && typeof message.id === 'string') await this.controller.sendQueued(message.id); return;
      case 'steer': if ('id' in message && typeof message.id === 'string') await this.controller.steerQueued(message.id); return;
      case 'removeQueued': if ('id' in message && typeof message.id === 'string') this.controller.removeQueued(message.id); return;
      case 'resolvePermission': await this.resolvePermission(message); return;
      case 'resolvePlan': this.resolvePlan(message); return;
      case 'resolveQuestion': this.resolveQuestion(message); return;
      case 'openDiff':
      case 'openFile':
      case 'revertFile': await this.reviewFile(String(message.type), 'path' in message ? message.path : undefined); return;
      case 'restoreSession': await this.restoreSession('id' in message ? message.id : undefined); return;
      case 'addDirectory': await this.addDirectory(); return;
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
      case 'send':
      case 'enqueue': {
        const selection = this.parseSelection(message);
        await this.controller.select(selection);
        if (message.type === 'send' || message.type === 'enqueue') {
          const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt : '';
          if (prompt.length > 100000) throw new Error('依頼は100,000文字以内で入力してください。');
          const images = sanitizeImages('images' in message ? message.images : undefined);
          if (!prompt.trim() && !images.length) return;
          this.requireWorkspace(selection.cwd);
          await this.deliver(prompt, images, message.type === 'enqueue');
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

  stop(): void { this.controller.stop(); }

  async insertContext(kind: 'file' | 'selection' | 'problems' | 'git' | 'terminal'): Promise<void> {
    await vscode.commands.executeCommand('ai-agents.chat.focus');
    const deadline = Date.now() + 2000;
    while (!this.isReady() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const cwd = this.controller.snapshot().selection.cwd;
    if (!cwd) throw new Error('作業対象のフォルダをVS Codeで開いてください。');
    const text = kind === 'file' ? this.fileToken(cwd)
      : kind === 'selection' ? selectionBlock(cwd) ?? ''
        : kind === 'problems' ? problemsText(cwd)
          : kind === 'git' ? await gitSummary(cwd)
            : recentTerminalText();
    if (text) this.post({ type: 'insert', text });
  }

  private fileToken(cwd: string): string {
    const token = activeFileToken(cwd);
    if (!token) return '';
    return `@${token.includes(' ') ? `"${token}"` : token} `;
  }

  private remember(summary: SessionSummary): void {
    this.controller.rememberSession(summary);
    void this.context.workspaceState.update('ai-agents.sessionIndex', this.controller.snapshot().sessions);
  }

  private async deliver(prompt: string, images: ImageAttachment[], forceQueue: boolean): Promise<void> {
    const cwd = this.controller.snapshot().selection.cwd;
    const builtin = builtinCommand(prompt);
    if (builtin?.name === 'clear' && !builtin.rest) { await this.newChat(); return; }
    if (builtin?.name === 'compact') {
      const session = this.controller.currentSession();
      if (!session?.compact) throw new Error('このバックエンドはコンテキスト圧縮に対応していません。');
      await session.compact();
      this.controller.notify('コンテキストを圧縮しました。');
      return;
    }
    let text = prompt;
    if (builtin?.name === 'review') {
      const session = this.controller.currentSession();
      if (!builtin.rest && session?.review && capabilitiesFor(this.controller.snapshot().selection.provider, this.controls[this.controller.snapshot().selection.provider].backend).review) {
        await this.controller.review('uncommitted');
        return;
      }
      text = `${builtin.rest || 'Review the current changes.'}\n\n${await gitSummary(cwd)}`;
    } else if (builtin?.name === 'diagnostics') text = `${builtin.rest}\n\n${problemsText(cwd)}`.trim();
    else if (builtin?.name === 'diff') text = `${builtin.rest}\n\n${await gitSummary(cwd)}`.trim();
    else if (builtin?.name === 'terminal') text = `${builtin.rest}\n\n${recentTerminalText()}`.trim();
    const expanded = await expandPrompt(text, cwd, await workspaceCommands(cwd));
    const extras = { displayText: prompt, ...(images.length ? { images } : {}) };
    if (forceQueue || this.controller.snapshot().busy) {
      this.controller.enqueue(expanded, extras);
      return;
    }
    const provider = this.controller.snapshot().selection.provider;
    this.output.appendLine(`[${provider}] Start (${cwd})`);
    await this.controller.send(expanded, extras);
    this.output.appendLine(`[${provider}] Finished`);
  }

  private async configure(message: object): Promise<void> {
    const provider = this.controller.snapshot().selection.provider;
    const current = this.controls[provider];
    const read = (key: string) => key in message ? (message as Record<string, unknown>)[key] : undefined;
    const mode = read('mode');
    const sandbox = read('sandbox');
    const approval = read('approval');
    const backend = read('backend');
    const network = read('network');
    const webSearch = read('webSearch');
    const next = normalizeControls(provider, {
      ...current,
      ...(mode === 'agent' || mode === 'plan' || mode === 'ask' ? { mode } : {}),
      ...(typeof sandbox === 'string' ? { sandbox } : {}),
      ...(typeof approval === 'string' ? { approval } : {}),
      ...(backend === 'sdk' || backend === 'acp' || backend === 'app-server' ? { backend } : {}),
      ...(typeof network === 'boolean' ? { network } : {}),
      ...(typeof webSearch === 'string' ? { webSearch } : {}),
    });
    const structural = current.backend !== next.backend || current.sandbox !== next.sandbox || current.approval !== next.approval
      || current.network !== next.network || current.webSearch !== next.webSearch
      || current.additionalDirectories.join('\0') !== next.additionalDirectories.join('\0');
    const modeChanged = current.mode !== next.mode;
    this.controls[provider] = next;
    await this.context.workspaceState.update('ai-agents.controls', this.controls);
    if (structural && this.controller.hasSession()) {
      await this.controller.reset();
      this.controller.notify('設定を変更したため、新しい会話になりました。');
    } else if (modeChanged) {
      const applied = await this.controller.applyMode(next.mode);
      if (!applied && this.controller.hasSession()) await this.controller.reset();
    }
    this.postState();
  }

  private async suggest(message: object): Promise<void> {
    const kind = 'kind' in message && message.kind === 'slash' ? 'slash' : 'file';
    const query = 'query' in message && typeof message.query === 'string' ? message.query.slice(0, 200) : '';
    const requestId = 'requestId' in message && typeof message.requestId === 'number' ? message.requestId : 0;
    const cwd = this.controller.snapshot().selection.cwd;
    if (!cwd) { this.post({ type: 'suggestions', requestId, items: [] }); return; }
    const items = kind === 'file'
      ? await searchWorkspace(cwd, query)
      : (await workspaceCommands(cwd)).filter((command) => command.name.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
        .map((command) => ({ label: `/${command.name}`, description: command.description, token: command.name }));
    this.post({ type: 'suggestions', requestId, items });
  }

  private async resolvePermission(message: object): Promise<void> {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const decision = 'decision' in message ? message.decision : undefined;
    if (decision === 'allow-once' || decision === 'allow-session' || decision === 'deny') this.controller.resolvePermission(id, decision);
  }

  private resolvePlan(message: object): void {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const decision = 'decision' in message && message.decision === 'rejected' ? 'rejected' : 'accepted';
    if (id) this.controller.resolvePlan(id, decision);
  }

  private resolveQuestion(message: object): void {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const answers = 'answers' in message && message.answers && typeof message.answers === 'object' ? message.answers as Record<string, string[]> : {};
    if (id) this.controller.resolveAnswers(id, answers);
  }

  private async reviewFile(type: string, filePath: unknown): Promise<void> {
    if (typeof filePath !== 'string' || !filePath) return;
    const roots = this.folders().map((folder) => folder.path);
    const change = this.controller.snapshot().changes.find((item) => item.path === filePath);
    if (type === 'openFile') {
      if (!change && !roots.some((root) => filePath.startsWith(root))) throw new Error('ワークスペース外のファイルは変更できません。');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
      return;
    }
    if (!change) return;
    if (type === 'revertFile') {
      await revertChange(change, roots);
      this.controller.notify(`Reverted ${path.basename(filePath)}`);
      return;
    }
    if (change.previousText === undefined && !change.diff) {
      await vscode.window.showTextDocument(vscode.Uri.file(change.path));
      return;
    }
    const baseline = await writeBaselineFile(path.join(this.context.globalStorageUri.fsPath, 'review'), { ...change, previousText: change.previousText ?? '' });
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(baseline), vscode.Uri.file(change.path), `${path.basename(change.path)}: before ↔ current`);
  }

  private async restoreSession(id: unknown): Promise<void> {
    if (typeof id !== 'string') return;
    const provider = this.controller.snapshot().selection.provider;
    const summary = this.controller.snapshot().sessions.find((session) => session.id === id && session.provider === provider);
    if (!summary) return;
    this.resumeId = summary.id;
    try {
      await this.controller.reset();
      await this.controller.openSession();
    } finally { this.resumeId = undefined; }
  }

  private async addDirectory(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
    const folder = picked?.[0]?.fsPath;
    if (!folder) return;
    const provider = this.controller.snapshot().selection.provider;
    const current = this.controls[provider];
    if (current.additionalDirectories.includes(folder)) return;
    this.controls[provider] = { ...current, additionalDirectories: [...current.additionalDirectories, folder] };
    await this.context.workspaceState.update('ai-agents.controls', this.controls);
    if (this.controller.hasSession()) {
      await this.controller.reset();
      this.controller.notify('設定を変更したため、新しい会話になりました。');
    }
    this.postState();
  }

  private async refreshSessions(): Promise<void> {
    let sessions = this.controller.snapshot().sessions;
    const selection = this.controller.snapshot().selection;
    try {
      if (selection.provider === 'cursor' && this.controls.cursor.backend === 'sdk' && selection.cwd) {
        const listed = await listCursorSdkSessions({
          cwd: selection.cwd,
          storagePath: path.join(this.context.globalStorageUri.fsPath, 'cursor-agents'),
          apiKey: await this.context.secrets.get('ai-agents.cursor.apiKey'),
        });
        for (const session of listed) sessions = upsertSession(sessions, session);
      }
      const live = await this.controller.currentSession()?.listSessions?.();
      for (const session of live ?? []) sessions = upsertSession(sessions, session);
    } catch (error) {
      this.output.appendLine(errorMessage(error));
    }
    this.controller.replaceSessions(sessions);
    await this.context.workspaceState.update('ai-agents.sessionIndex', this.controller.snapshot().sessions);
  }

  async showDiagnostics(): Promise<void> {
    const selection = this.controller.snapshot().selection;
    const checks = [];
    if (selection.provider === 'cursor') {
      const agentPath = vscode.workspace.getConfiguration('ai-agents').get<string>('cursor.agentPath') || 'agent';
      checks.push(await runProcess(agentPath, ['--version'], selection.cwd || undefined));
      checks.push(await runProcess(agentPath, ['status'], selection.cwd || undefined));
      try {
        const { Cursor } = await import('@cursor/sdk');
        const status = await Cursor.auth.status();
        checks.push({ label: 'Cursor SDK auth', ok: status.status === 'logged-in', output: status.status });
      } catch (error) {
        checks.push({ label: 'Cursor SDK auth', ok: false, output: errorMessage(error) });
      }
    } else {
      const codexPath = vscode.workspace.getConfiguration('ai-agents').get<string>('codex.executablePath') || 'codex';
      checks.push(await runProcess(codexPath, ['--version'], selection.cwd || undefined));
    }
    this.post({ type: 'inspector', title: 'Diagnostics', text: checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.label}\n${check.output}`).join('\n\n') });
  }

  private async showUsage(): Promise<void> {
    const usage = this.controller.snapshot().usage;
    const limits = await this.controller.currentSession()?.rateLimits?.().catch((error: unknown) => errorMessage(error)) ?? '';
    const text = [usage ? `input ${usage.inputTokens} / output ${usage.outputTokens}` : 'No token usage yet.', limits].filter(Boolean).join('\n');
    this.post({ type: 'inspector', title: 'Usage', text });
  }

  private async showInstructions(): Promise<void> {
    const cwd = this.controller.snapshot().selection.cwd;
    const local = cwd ? await instructionSummary(cwd) : '';
    const live = await this.controller.currentSession()?.instructions?.().catch((error: unknown) => errorMessage(error)) ?? '';
    this.post({ type: 'inspector', title: 'Rules / Skills / MCP', text: [local, live].filter(Boolean).join('\n\n') });
  }

  private async toggleAutoApprove(): Promise<void> {
    const next = !this.controller.snapshot().autoApprove;
    if (next) {
      const enable = this.locale === 'ja' ? '有効にする' : 'Enable';
      const warning = this.locale === 'ja'
        ? '自動承認を有効にしますか？ファイル変更とコマンド実行の確認を省略します。サンドボックスが無効になるという意味ではありません。'
        : 'Enable auto-approve? File changes and commands will be allowed without a prompt. This does not disable the sandbox.';
      const choice = await vscode.window.showWarningMessage(warning, { modal: true }, enable);
      if (choice !== enable) return;
    }
    await vscode.workspace.getConfiguration('ai-agents').update('autoApprove', next, vscode.ConfigurationTarget.Global);
    this.controller.setAutoApprove(next);
    if (next) this.controller.notify(this.locale === 'ja'
      ? '自動承認を有効にしました。サンドボックスの強制とは別です。危険な操作も確認なしで許可されます。'
      : 'Auto-approve is on. This is separate from the sandbox; risky actions are allowed without a prompt.');
  }

  private showError(error: unknown): void {
    const message = errorMessage(error);
    this.output.appendLine(message);
    this.post({ type: 'error', text: message });
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
    const ja = this.locale === 'ja';
    const label = (japanese: string, english: string) => ja ? japanese : english;
    return `<!DOCTYPE html>
<html lang="${ja ? 'ja' : 'en'}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"><title>AI Agents</title>
</head><body>
<header><strong>AI Agents <span id="connection"></span></strong><div class="header-actions"><button id="history" class="secondary" type="button">${label('履歴', 'History')}</button><button id="changes" class="secondary" type="button">${label('変更', 'Changes')}</button><button id="newChat" type="button">${label('新しい会話', 'New chat')}</button></div></header>
<div id="historyList" class="card" hidden></div>
<div id="changeList" class="card" hidden></div>
<section class="controls" aria-label="${label('エージェント設定', 'Agent settings')}">
<label>${label('エージェント', 'Agent')}<select id="provider"><option value="codex">Codex</option><option value="cursor">Cursor</option></select></label>
<div class="model-control"><span id="modelLabel">${label('モデル', 'Model')}</span><div class="model-buttons"><button id="model" type="button" aria-labelledby="modelLabel model">${label('モデルを選択', 'Select model')} ▾</button><button id="modelDetails" type="button">${label('詳細設定', 'Details')}</button></div></div>
<label class="wide">${label('作業フォルダ', 'Folder')}<select id="folder"></select></label>
<label>${label('バックエンド', 'Backend')}<select id="backend"></select></label>
<label>${label('モード', 'Mode')}<select id="mode"></select></label>
<label>${label('サンドボックス', 'Sandbox')}<select id="sandbox"></select></label>
<label>${label('承認', 'Approval')}<select id="approval"></select></label>
<label>${label('検索', 'Search')}<select id="webSearch"></select></label>
<label class="wide">${label('ネットワークを明示的に許可', 'Explicitly allow network')}<input id="network" type="checkbox"></label>
</section>
<nav><button id="login" type="button">${label('ログイン', 'Sign in')}</button><button id="apiKey" type="button">${label('APIキー', 'API key')}</button><button id="settings" type="button">${label('設定', 'Settings')}</button><button id="logs" type="button">${label('ログ', 'Logs')}</button><button id="diagnose" type="button">${label('診断', 'Diagnose')}</button><button id="usage" type="button">${label('使用量', 'Usage')}</button><button id="instructions" type="button">${label('ルール', 'Rules')}</button><button id="autoApprove" type="button" aria-pressed="false">${label('自動承認', 'Auto-approve')}</button></nav>
<div class="tool-row"><button id="activeFile" type="button">${label('ファイル', 'File')}</button><button id="selectionBtn" type="button">${label('選択範囲', 'Selection')}</button><button id="problems" type="button">${label('問題', 'Problems')}</button><button id="git" type="button">${label('差分', 'Diff')}</button><button id="terminalBtn" type="button">${label('ターミナル', 'Terminal')}</button></div>
<section id="inspector" hidden><h3 id="inspectorTitle"></h3><pre id="inspectorBody"></pre><button id="inspectorClose" class="secondary" type="button">${label('閉じる', 'Close')}</button></section>
<main id="messages" role="log" aria-label="${label('会話', 'Conversation')}" aria-live="polite"></main>
<div id="pending" hidden></div>
<div id="status" role="status">${label('準備中…', 'Starting…')}</div>
<form id="composer"><label class="sr-only" for="prompt">${label('エージェントへの依頼', 'Prompt')}</label>
<div id="contextTray"></div><div id="attachmentTray"></div><div id="queueTray"></div><div id="suggest" hidden></div>
<textarea id="prompt" rows="4" placeholder="${label('質問、または変更を依頼…', 'Ask a question or request a change…')}" maxlength="100000"></textarea>
<footer><small>${label('Enterで送信 · Shift+Enterで改行', 'Enter to send · Shift+Enter for a new line')}</small><button id="attach" class="secondary" type="button">${label('画像', 'Image')}</button><button id="stop" type="button" hidden>${label('停止', 'Stop')}</button><button id="send" type="submit">${label('送信', 'Send')}</button></footer>
<input id="imageInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
</form>
<p class="hint">${label('SDKが既定です。対話型の承認には Codex は App Server、Cursor は ACP を選んでください。', 'SDK is the default. For interactive approvals, choose Codex App Server or Cursor ACP.')}</p>
<script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body></html>`;
  }
}
