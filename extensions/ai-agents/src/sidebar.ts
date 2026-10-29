import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { capabilitiesFor, defaultControls, modelApplyMode, normalizeControls, type AgentControls } from './capabilities.js';
import { inferIntent } from './plan-state.js';
import { revertChange } from './change-review.js';
import { applyUndoAll, captureAcceptance, changeSetFingerprint, inspectUndoAll, readChangeDigest, undoReasonText } from './review-acceptance.js';
import { createCodexCliHistory } from './providers/codex-cli-history.js';
import { listCursorCliSessions } from './providers/cursor-cli.js';
import { usageText } from './usage.js';
import { BackgroundTerminalViews } from './background-terminal.js';
import { ChatController } from './chat-controller.js';
import { discardTurnRewindJournal, readTurnRewindJournal, rollbackTurnRewindJournal } from './turn-rewind.js';
import { builtinCommand, expandPrompt } from './context-text.js';
import { runProcess } from './diagnostics.js';
import { agentLaunch, codexLaunch } from './providers/codex-binary.js';
import { localeFrom } from './i18n.js';
import { sanitizeImages } from './images.js';
import { baseModelLabel, matchesModel, selectBaseModel } from './model-selection.js';
import { ModelDetails } from './model-details.js';
import { catalogIsCurrent, ModelSettingsDraft, sameModelParams, toCatalogModel } from './model-settings.js';
import { createSession, writeBaselineFile } from './providers/index.js';
import { listModels } from './providers/models.js';
import type { HostToWebview, ProbeResult, ViewMessage } from './protocol.js';
import { mergeRegistrySessions } from './session-index.js';
import { extensionBadge } from './diff-stats.js';
import { resolveThemeIcon, type IconThemeDocument } from './icon-theme.js';
import { HistoryStore, type SavedConversation } from './history-store.js';
import { SessionRegistry } from './session-registry.js';
import { errorMessage, type AgentModel, type Backend, type ChatState, type ImageAttachment, type PlanState, type Provider, type Selection, type SessionSummary } from './types.js';
import { buildShell, diffMessages, toViewMessage } from './view-state.js';
import { activeFileToken, gitSummary, instructionSummary, problemsText, recentTerminalText, searchWorkspace, selectionBlock, watchTerminals, workspaceCommands } from './vscode-context.js';

type SavedModel = Pick<Selection, 'model' | 'modelParams'> & { label: string; hasDetails?: boolean };
interface ModelItem extends vscode.QuickPickItem { model: AgentModel }

export class AgentsSidebar implements vscode.WebviewViewProvider {
  private readonly terminalViews = new BackgroundTerminalViews();
  private readonly historyReady: Promise<void>;
  private readonly displayHistory: HistoryStore;
  private displayLoaded = false;
  private readonly rewindJournalDirectory: string;
  private readonly rewindErrors: string[] = [];
  private readonly conversationIds = new WeakMap<ChatController, string>();
  private readonly controllerControls = new WeakMap<ChatController, AgentControls>();
  private retryDraft?: { controller: ChatController; id: string; text: string };
  private historyPaused = false;
  private readonly loggedErrors = new Set<string>();
  private readonly views = new Set<vscode.WebviewView>();
  private readonly readyViews = new Set<vscode.WebviewView>();
  private readonly controls: Record<Provider, AgentControls>;
  private readonly locale = localeFrom(vscode.env.language);
  private lastBusy = false;
  private readonly registry: SessionRegistry;
  private readonly savedPlans: Record<string, PlanState>;
  private iconThemeKey = '';
  private iconTheme?: IconThemeDocument;
  private iconThemeDir?: vscode.Uri;
  private modelPicker?: vscode.QuickPick<ModelItem>;
  private activePickerModel?: string;
  private modelRequest?: AbortController;
  private readonly modelCache = new Map<string, AgentModel[]>();
  private catalogAbort?: AbortController;
  private catalogRequest = 0;
  private detailsEditor?: ModelDetails;
  private detailsRequest?: AbortController;
  private readonly selectedModels: Partial<Record<Provider, SavedModel>>;
  private dismissedWarning: string | null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private probeWait?: (result: ProbeResult) => void;
  private readonly sync = new Map<vscode.WebviewView, { sigs: Map<string, string>; revision: number }>();
  get controller(): ChatController { return this.registry.front; }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly sessionFactory: typeof createSession = createSession,
  ) {
    const historyRoot = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'history', 'v1');
    this.rewindJournalDirectory = path.join(historyRoot, 'rewind-journals');
    this.displayHistory = new HistoryStore(path.join(this.historyRoot(), 'conversations'), (error) => {
      this.output.appendLine(errorMessage(error));
    });
    this.historyReady = Promise.all([
      this.recoverTurnRewinds().catch((error) => { this.rewindErrors.push(errorMessage(error)); }),
      this.displayHistory.load().catch((error) => { this.output.appendLine(errorMessage(error)); }),
    ]).then(() => { this.displayLoaded = true; });
    const config = vscode.workspace.getConfiguration('ai-agents');
    const provider = config.get<Provider>('defaultProvider', 'codex');
    const storedControls = context.workspaceState.get<Partial<Record<Provider, AgentControls>>>('ai-agents.controls', {});
    this.controls = {
      codex: normalizeControls('codex', { ...defaultControls('codex', 'cli'), ...storedControls.codex, backend: 'cli' }),
      cursor: normalizeControls('cursor', { ...defaultControls('cursor', 'cli'), ...storedControls.cursor, backend: 'cli' }),
    };
    this.selectedModels = context.workspaceState.get('ai-agents.selectedModels', {});
    this.dismissedWarning = context.workspaceState.get<string>('ai-agents.dismissedWarning') ?? null;
    for (const saved of Object.values(this.selectedModels)) saved.label = baseModelLabel(saved.label);
    const saved = this.selectedModels[provider];
    this.savedPlans = context.workspaceState.get<Record<string, PlanState>>('ai-agents.plans', {});
    const initial = this.makeController({
      provider,
      cwd: this.folders()[0]?.path ?? '',
      model: saved?.model ?? config.get<string>(`${provider}.model`, ''),
      ...(saved?.modelParams ? { modelParams: saved.modelParams } : {}),
    });
    this.registry = new SessionRegistry(initial, this.controls[provider].mode);
    initial.setModePreference(this.controls[provider].mode);
    this.controller.setAutoApprove(config.get<boolean>('autoApprove', false) === true);
    void this.historyReady.then(() => {
      this.publishDisplaySessions();
      for (const error of this.rewindErrors) this.controller.notify(error);
    }).catch((e) => this.showError(e));
    context.subscriptions.push(vscode.commands.registerCommand('ai-agents.clearLocalHistory', async () => {
      const choice = await vscode.window.showWarningMessage('残っているローカルの表示履歴ファイルと巻き戻しジャーナルを削除します。バックエンドの会話は削除しません。', { modal: true }, '現在の会話', 'すべて');
      if (!choice) return;
      this.historyPaused = true;
      try {
        if (choice === 'すべて') {
          await this.deleteLeftoverConversations();
          await this.displayHistory.clear();
        } else {
          const id = this.conversationIds.get(this.controller);
          if (id) await this.displayHistory.clear(id);
        }
      } finally { this.historyPaused = false; }
      if (choice === 'すべて') for (const key of Object.keys(this.savedPlans)) delete this.savedPlans[key];
      else { const key = this.controller.sessionId(); if (key) delete this.savedPlans[key]; }
      await this.context.workspaceState.update('ai-agents.plans', this.savedPlans);
      if (choice === 'すべて') this.controller.replaceSessions(mergeRegistrySessions([], this.registry.liveSummaries()));
    }));
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

  private makeController(selection: Selection): ChatController {
    // ChatController stores these callbacks; it does not invoke them in its constructor.
    // This method seeds its ID/controls before returning, and callers register it before exposing operations that invoke them.
    let controller!: ChatController;
    controller = new ChatController(selection, async (next, sessionContext) => {
      this.requireWorkspace(next.cwd);
      const conversation = this.registry.entries().find((entry) => entry.controller === controller)!;
      const controls = { ...this.controllerControls.get(controller)!, mode: conversation.mode };
      return this.sessionFactory({
        ...next,
        ...controls,
        ownerKey: this.conversationIds.get(controller),
        storagePath: path.join(this.context.globalStorageUri.fsPath, 'cursor-agents'),
        apiKey: await this.context.secrets.get(`ai-agents.${next.provider}.apiKey`),
        codexPath: vscode.workspace.getConfiguration('ai-agents').get<string>('codex.executablePath'),
        agentPath: vscode.workspace.getConfiguration('ai-agents').get<string>('cursor.agentPath') || 'agent',
        resumeId: sessionContext?.resumeId,
        signal: sessionContext?.signal,
        interactions: controller.interactions,
        onIdentity: (summary) => this.rememberFor(controller, summary),
      });
    }, (state) => {
      this.saveConversation(controller, state);
      this.postState();
    }, {
      journalDirectory: this.rewindJournalDirectory,
      conversationId: () => this.conversationIds.get(controller),
      enabled: () => !this.historyPaused
        && vscode.workspace.getConfiguration('ai-agents').get<boolean>('history.enabled', true),
      flush: () => this.flushHistory(),
    });
    this.conversationIds.set(controller, randomUUID());
    this.controllerControls.set(controller, { ...this.controls[selection.provider] });
    return controller;
  }

  private async recoverTurnRewinds(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.rewindJournalDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names.filter((item) => /^[a-f0-9-]+\.json$/.test(item))) {
      const file = path.join(this.rewindJournalDirectory, name);
      try {
        const journal = await readTurnRewindJournal(file);
        if (journal.committed === true) {
          await discardTurnRewindJournal(file);
          continue;
        }
        const cwd = await realpath(journal.cwd);
        const folders = await Promise.all(this.folders().map(async (folder) => realpath(folder.path).catch(() => folder.path)));
        if (cwd !== journal.cwd || !folders.includes(cwd)) throw new Error('ジャーナルのWorkspaceが保存された会話と一致しません。');
        await rollbackTurnRewindJournal(journal);
        await discardTurnRewindJournal(file);
      } catch (error) {
        this.rewindErrors.push(`巻き戻し中断から自動復旧できませんでした。ファイルは保持しました: ${name} (${errorMessage(error)})`);
      }
    }
  }

  private saveConversation(controller: ChatController, state: ChatState): void {
    if (!state.messages.length) {
      this.conversationIds.set(controller, randomUUID());
      this.controllerControls.set(controller, { ...this.controls[state.selection.provider] });
      return;
    }
    for (const message of state.messages) if (message.role === 'error' && !this.loggedErrors.has(message.id)) {
      this.loggedErrors.add(message.id);
      this.output.appendLine(errorMessage(`[${state.selection.provider}/${this.controllerControls.get(controller)?.backend}] ${message.failure?.kind ?? 'Error'} ${message.failure?.operation ?? ''}\n${message.text}`));
    }
    this.persistPlan(controller, state);
    if (this.displayLoaded) this.persistDisplay(controller, state);
    else void this.historyReady.then(() => this.persistDisplay(controller, state)).catch((error: unknown) => this.output.appendLine(errorMessage(error)));
  }

  private persistDisplay(controller: ChatController, state: ChatState): void {
    if (this.historyPaused || !vscode.workspace.getConfiguration('ai-agents').get<boolean>('history.enabled', true)) return;
    const id = this.conversationIds.get(controller);
    const controls = this.controllerControls.get(controller);
    if (!id || !controls || !state.messages.length) return;
    let snapshot: ChatState;
    try { snapshot = structuredClone(state); }
    catch (error) { this.output.appendLine(errorMessage(error)); return; }
    snapshot.busy = false;
    snapshot.pendingPermission = null;
    snapshot.pendingPlan = null;
    snapshot.pendingQuestion = null;
    const sessionId = controller.sessionId();
    this.displayHistory.schedule({
      version: 1,
      id,
      ...(sessionId ? { sessionId } : {}),
      updatedAt: new Date().toISOString(),
      controls,
      state: snapshot,
    });
  }

  private persistPlan(controller: ChatController, state: ChatState): void {
    if (this.historyPaused) return;
    const sessionId = controller.sessionId();
    if (!sessionId) return;
    const phase = state.plan.phase;
    const settled = (phase === 'ready' || phase === 'implemented') && Boolean(state.plan.current);
    const interrupted = phase === 'planning' || phase === 'revising' || phase === 'building' || (phase === 'unknown' && Boolean(state.plan.current));
    if (!settled && !interrupted) return;
    const next = structuredClone(state.plan);
    if (JSON.stringify(this.savedPlans[sessionId]) === JSON.stringify(next)) return;
    this.savedPlans[sessionId] = next;
    void this.context.workspaceState.update('ai-agents.plans', this.savedPlans);
  }

  private publishDisplaySessions(): void {
    const selection = this.controller.snapshot().selection;
    const stored = this.displayHistory.summaries().filter((item) => item.provider === selection.provider && (!selection.cwd || item.cwd === selection.cwd));
    if (!stored.length) return;
    this.controller.replaceSessions(mergeRegistrySessions(this.controller.snapshot().sessions, stored));
  }

  private applyRestoredDisplay(target: ChatController, record: SavedConversation | undefined, sessionId: string): void {
    const after = target.snapshot();
    const visible = after.messages.some((message) => message.role === 'user' || message.role === 'assistant');
    const failed = after.status === 'error' || after.messages.some((message) => message.role === 'error');
    if (record?.sessionId && !visible && !failed) target.restoreSnapshot(record.state, record.sessionId);
    const saved = this.savedPlans[sessionId];
    const plan = target.snapshot().plan;
    if (saved?.current && !plan.current && !plan.draft) target.restorePlan(saved);
  }

  async flushHistory(): Promise<void> {
    await this.historyReady;
    await this.displayHistory.flush();
  }

  private historyRoot(): string {
    return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, 'history', 'v1');
  }

  private async deleteLeftoverConversations(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.historyRoot()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      await unlink(path.join(this.historyRoot(), name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    let journals: string[] = [];
    try { journals = await readdir(this.rewindJournalDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of journals) {
      if (!name.endsWith('.json')) continue;
      await unlink(path.join(this.rewindJournalDirectory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  private async probeSessions(selection: Selection): Promise<SessionSummary[]> {
    const config = vscode.workspace.getConfiguration('ai-agents');
    if (selection.provider === 'cursor') {
      return listCursorCliSessions({
        provider: 'cursor', cwd: selection.cwd, model: selection.model, ...(selection.modelParams ? { modelParams: selection.modelParams } : {}),
        storagePath: path.join(this.context.globalStorageUri.fsPath, 'cursor-agents'),
        agentPath: config.get<string>('cursor.agentPath') || 'agent',
        apiKey: await this.context.secrets.get('ai-agents.cursor.apiKey'),
        backend: 'cli',
      });
    }
    const history = createCodexCliHistory({
      provider: 'codex', cwd: selection.cwd, model: selection.model, ...(selection.modelParams ? { modelParams: selection.modelParams } : {}),
      storagePath: this.context.globalStorageUri.fsPath,
      codexPath: config.get<string>('codex.executablePath'),
      apiKey: await this.context.secrets.get('ai-agents.codex.apiKey'),
      backend: 'cli', sandbox: this.controls.codex.sandbox,
    });
    return history.listThreads?.() ?? [];
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
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message, view).catch((error: unknown) => this.showError(error));
    });
    view.onDidDispose(() => {
      listener.dispose();
      this.views.delete(view);
      this.readyViews.delete(view);
      this.sync.delete(view);
    });
    view.webview.html = this.html(view.webview);
  }

  isReady(): boolean { return this.readyViews.size > 0; }

  private post(message: unknown): void {
    for (const view of this.readyViews) void view.webview.postMessage(message);
  }

  private postState(): void {
    if (!this.controller.snapshot().busy) {
      this.flushNow();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flushNow(); }, 16);
  }

  private flushNow(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.readyViews.size) return;
    const state = this.controller.snapshot();
    state.sessions = mergeRegistrySessions(state.sessions, this.registry.liveSummaries());
    if (state.busy !== this.lastBusy) {
      this.lastBusy = state.busy;
      void vscode.commands.executeCommand('setContext', 'ai-agents.busy', state.busy);
    }
    const provider = state.selection.provider;
    const controls = this.controls[provider];
    const saved = this.selectedModels[provider];
    const token = activeFileToken(state.selection.cwd);
    const shell = buildShell({
      state, folders: this.folders(),
      modelLabel: (state.selection.model ? saved?.label || state.selection.model : '') || (this.locale === 'ja' ? 'モデルを選択' : 'Select model'),
      hasModelDetails: saved?.hasDetails === true,
      capabilities: capabilitiesFor(provider, controls.backend),
      controls: { ...controls, mode: this.registry.mode() }, locale: this.locale, sessionId: this.controller.sessionId(),
      conversationId: this.registry.frontKey,
      activeFile: token ? { token, label: path.basename(token) } : null,
      dismissedWarning: this.dismissedWarning,
      tokens: this.controller.interactionTokens(),
      backends: { codex: this.controls.codex.backend, cursor: this.controls.cursor.backend },
      reviewProbe: this.controller.reviewProbeSnapshot(),
    });
    const rewindable = state.selection.provider === 'codex' && (controls.backend === 'app-server' || controls.backend === 'cli') ? this.controller.rewindableTurnIds() : new Set<string>();
    const messages = state.messages.map((message) => toViewMessage(message, message.role === 'user' && rewindable.has(message.id)));
    for (const view of this.readyViews) {
      const current = this.sync.get(view) ?? { sigs: new Map<string, string>(), revision: 0 };
      const full = current.revision === 0;
      const visible = this.decorateMessages(messages, view.webview);
      const diff = diffMessages(current.sigs, visible);
      current.sigs = diff.next;
      current.revision += 1;
      this.sync.set(view, current);
      void view.webview.postMessage({
        type: 'state', revision: current.revision, full, shell: this.decorateShell(shell, view.webview),
        messages: { removed: diff.removed, upserts: diff.upserts, order: diff.order },
      });
      view.description = shell.sessionTitle;
      const waiting = Boolean(shell.permission || shell.plan || shell.question);
      view.badge = waiting ? { value: 1, tooltip: shell.statusText } : undefined;
    }
    for (const entry of this.registry.background()) {
      if (!entry.controller.snapshot().busy && !entry.controller.hasLiveTerminals() && !entry.controller.hasLiveChildren()) void entry.controller.hibernate();
    }
    void this.refreshReviewProbe();
  }

  private undoAllLock = false;
  private reviewProbeToken = 0;

  private dirtyPaths(): Set<string> {
    const paths = new Set<string>();
    for (const document of vscode.workspace.textDocuments) {
      const doc = document as { isDirty?: boolean; uri?: { fsPath?: string } };
      if (doc.isDirty && doc.uri?.fsPath) paths.add(path.resolve(doc.uri.fsPath));
    }
    return paths;
  }

  private async refreshReviewProbe(): Promise<void> {
    const controller = this.controller;
    const token = ++this.reviewProbeToken;
    const state = controller.snapshot();
    const roots = this.folders().map((folder) => folder.path);
    const plan = await inspectUndoAll(state.changes, roots, this.dirtyPaths());
    if (token !== this.reviewProbeToken || this.controller !== controller) return;
    const digests: Record<string, string | null> = {};
    for (const change of state.changes) {
      const digest = await readChangeDigest(change, roots);
      if (digest !== undefined) digests[change.path] = digest;
    }
    if (token !== this.reviewProbeToken || this.controller !== controller) return;
    const fingerprint = changeSetFingerprint(state.changes);
    if (changeSetFingerprint(controller.snapshot().changes) !== fingerprint) return;
    controller.setReviewProbe({
      fingerprint,
      digests,
      undoEnabled: plan.ok,
      ...(plan.ok ? {} : { undoReason: undoReasonText(plan.blocks) }),
    });
  }

  private async keepAll(): Promise<void> {
    if (this.undoAllLock) return;
    const controller = this.controller;
    const roots = this.folders().map((folder) => folder.path);
    const fingerprint = changeSetFingerprint(controller.snapshot().changes);
    const captured = await captureAcceptance(controller.snapshot().changes, roots);
    if (!captured.ok) throw new Error(captured.reason);
    if (this.controller !== controller || changeSetFingerprint(controller.snapshot().changes) !== fingerprint) {
      throw new Error(this.locale === 'ja' ? '変更集合が変わったため、受け入れを中止しました。' : 'The change set changed, so Keep All was cancelled.');
    }
    if (!controller.acceptReview(captured.acceptance)) {
      throw new Error(this.locale === 'ja' ? '変更集合が変わったため、受け入れを中止しました。' : 'The change set changed, so Keep All was cancelled.');
    }
  }

  private async undoAll(): Promise<void> {
    if (this.undoAllLock) return;
    this.undoAllLock = true;
    try {
      const controller = this.controller;
      const roots = this.folders().map((folder) => folder.path);
      const plan = await inspectUndoAll(controller.snapshot().changes, roots, this.dirtyPaths());
      if (!plan.ok) throw new Error(undoReasonText(plan.blocks) || (this.locale === 'ja' ? '安全に一括Undoできないため中止しました。' : 'Undo All was cancelled because it is not safe.'));
      const names = plan.targets.map((change) => path.basename(change.path));
      const label = this.locale === 'ja' ? 'すべて戻す' : 'Undo All';
      const preview = names.slice(0, 20).join('\n');
      const more = names.length > 20 ? `\n… +${names.length - 20}` : '';
      const choice = await vscode.window.showWarningMessage(
        this.locale === 'ja'
          ? `次の ${names.length} ファイルを変更前の内容に戻します。\n${preview}${more}`
          : `Restore ${names.length} file(s) to their saved before-state.\n${preview}${more}`,
        { modal: true },
        label,
      );
      if (choice !== label || this.controller !== controller) return;
      const again = await inspectUndoAll(controller.snapshot().changes, roots, this.dirtyPaths());
      const same = again.ok && again.targets.map((item) => item.path).join('\0') === plan.targets.map((item) => item.path).join('\0');
      if (!same) throw new Error(this.locale === 'ja' ? '確認後にファイルが変わったため、一括Undoを中止しました。' : 'Files changed after confirmation, so Undo All was cancelled.');
      const result = await applyUndoAll(again.targets, roots, revertChange);
      if (result.restored.length) controller.removeChanges(result.restored);
      if (result.failed) {
        const done = result.restored.map((item) => path.basename(item)).join(', ') || (this.locale === 'ja' ? 'なし' : 'none');
        const failed = `${path.basename(result.failed.path)}: ${result.failed.message}`;
        throw new Error(this.locale === 'ja'
          ? `一部のファイルは復元できませんでした。復元済み: ${done}。失敗: ${failed}`
          : `Undo All did not finish. Restored: ${done}. Failed: ${failed}`);
      }
    } finally {
      this.undoAllLock = false;
    }
  }

  probe(): Promise<ProbeResult> {
    this.flushNow();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe timed out')), 5000);
      this.probeWait = (result) => { clearTimeout(timer); this.probeWait = undefined; resolve(result); };
      this.post({ type: 'probe' });
    });
  }

  private isProbe(message: object): message is ProbeResult {
    return 'turns' in message && typeof message.turns === 'number' && 'pending' in message && 'history' in message && 'settings' in message;
  }

  async handleMessage(message: unknown, source?: vscode.WebviewView): Promise<void> {
    await this.historyReady;
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    // Actions from an older render must never fall through to the new front conversation.
    if ('conversationId' in message && typeof message.conversationId === 'string' && !this.registry.get(message.conversationId)) return;
    const targeted = ['stop', 'resolvePermission', 'resolvePlan', 'resolveQuestion', 'terminateTerminal', 'openTerminal'];
    if (!targeted.includes(String(message.type)) && !this.isFront(message)) return;
    switch (message.type) {
      case 'ready':
        if (source) {
          this.sync.delete(source);
          this.readyViews.add(source);
        }
        this.postState();
        return;
      case 'probeResult':
        if (this.isProbe(message)) this.probeWait?.(message);
        return;
      case 'dismissWarning':
        if ('id' in message && typeof message.id === 'string') {
          this.dismissedWarning = message.id;
          await this.context.workspaceState.update('ai-agents.dismissedWarning', message.id);
          this.postState();
        }
        return;
      case 'removeDirectory':
        if ('path' in message && typeof message.path === 'string') await this.removeDirectory(message.path);
        return;
      case 'stop': this.targetController(message).stop(); return;
      case 'newChat': await this.newChat(); return;
      case 'chooseModel': await this.selectModel(); return;
      case 'modelDetails': await this.configureModel(); return;
      case 'loadModelCatalog': await this.loadModelCatalog(message); return;
      case 'setModel': await this.setMenuModel(message); return;
      case 'setModelParam': await this.setMenuParam(message); return;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-agents'); return;
      case 'logs': this.output.show(true); return;
      case 'diagnose': await this.showDiagnostics(); return;
      case 'copy': {
        if (!('text' in message) || typeof message.text !== 'string' || message.text.length > 10_000_000 || !('requestId' in message) || typeof message.requestId !== 'string') return;
        this.targetController(message);
        try { await vscode.env.clipboard.writeText(message.text); void source?.webview.postMessage({ type: 'copyResult', requestId: message.requestId, ok: true }); }
        catch { void source?.webview.postMessage({ type: 'copyResult', requestId: message.requestId, ok: false }); }
        return;
      }
      case 'prepareRetry':
      case 'prepareResend': {
        const controller = this.targetController(message);
        const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
        const state = controller.snapshot();
        const user = state.messages.find((m) => m.id === id && m.role === 'user');
        if (!user || state.busy) return;
        this.retryDraft = message.type === 'prepareRetry' ? { controller, id, text: user.text } : undefined;
        const original = controller.retryInput(id);
        const conversationKey = this.registry.entries().find((entry) => entry.controller === controller)?.key;
        const prepared: HostToWebview = {
          type: 'retryPrepared', id, text: user.text, images: original?.extras?.images ?? [],
          ...(user.attachments?.length ? { attachments: user.attachments } : {}),
          provider: state.selection.provider, cwd: state.selection.cwd,
          conversationId: conversationKey,
        };
        if (source) void source.webview.postMessage(prepared);
        else this.post(prepared);
        if (!original && user.attachments?.length) { this.post({ type: 'error', text: '添付を再指定して入力を確認してください。自動再実行はしません。' }); }
        return;
      }
      case 'rewind': {
        if (!('turnId' in message) || typeof message.turnId !== 'string' || !('editedText' in message) || typeof message.editedText !== 'string') return;
        await this.rewindPrompt(message, message.turnId, message.editedText);
        return;
      }
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
      case 'buildPlan': await this.buildPlan(message); return;
      case 'setBuildModel':
      case 'setBuildParam': await this.setBuildModel(message); return;
      case 'reviewChanges': await this.reviewAll(); return;
      case 'keepAllChanges': await this.keepAll(); return;
      case 'undoAllChanges': await this.undoAll(); return;
      case 'terminateTerminal': await this.terminateTerminal(message); return;
      case 'openTerminal': await this.openTerminal(message); return;
      case 'resolveQuestion': this.resolveQuestion(message); return;
      case 'openDiff':
      case 'openFile':
      case 'revertFile': await this.reviewFile(String(message.type), 'path' in message ? message.path : undefined, 'line' in message ? message.line : undefined, 'column' in message ? message.column : undefined, 'endLine' in message ? message.endLine : undefined); return;
      case 'restoreSession': await this.restoreSession('id' in message ? message.id : undefined); return;
      case 'addDirectory': await this.addDirectory(); return;
      case 'login': await this.signIn(); return;
      case 'apiKey': await this.setApiKey(); return;
      case 'select':
      case 'send':
      case 'enqueue': {
        const target = this.controller;
        const selection = this.parseSelection(message);
        await target.select(selection);
        if (this.controller !== target) return;
        if (message.type === 'send' || message.type === 'enqueue') {
          const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt : '';
          if (prompt.length > 100000) throw new Error('依頼は100,000文字以内で入力してください。');
          const imagesSpecified = 'images' in message;
          const images = sanitizeImages(imagesSpecified ? message.images : undefined);
          const attachments = 'attachments' in message && Array.isArray(message.attachments)
            ? message.attachments.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim().slice(0, 200)] : []).slice(0, 20)
            : [];
          if (!prompt.trim() && !images.length) return;
          this.requireWorkspace(selection.cwd);
          await this.deliver(prompt, images, message.type === 'enqueue', attachments, imagesSpecified);
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
    const config = vscode.workspace.getConfiguration('ai-agents');
    return listModels({
      provider: selection.provider, backend: this.controls[selection.provider].backend, cwd: selection.cwd || undefined, signal,
      apiKey: await this.context.secrets.get(`ai-agents.${selection.provider}.apiKey`),
      codexPath: config.get<string>('codex.executablePath'),
      agentPath: config.get<string>('cursor.agentPath'),
    });
  }

  private cacheKey(selection: Selection): string {
    return `${selection.provider}\0${this.controls[selection.provider].backend}\0${selection.cwd}`;
  }

  private async cachedModels(selection: Selection, refresh = false): Promise<AgentModel[]> {
    const key = this.cacheKey(selection);
    if (!refresh && this.modelCache.has(key)) return this.modelCache.get(key)!;
    const models = await this.listAvailableModels(selection);
    const current = this.controller.snapshot().selection;
    if (current.provider === selection.provider && current.cwd === selection.cwd) this.modelCache.set(key, models);
    return models;
  }

  private postCatalog(requestId: number, selection: Selection, models: AgentModel[]): void {
    this.post({
      type: 'modelCatalog', requestId, provider: selection.provider, cwd: selection.cwd, status: 'ready',
      models: models.map((model) => toCatalogModel(model)),
      selectedModelId: selection.model, selectedParams: selection.modelParams ?? [],
    });
  }

  private async loadModelCatalog(message: object): Promise<void> {
    const requestId = 'requestId' in message && typeof message.requestId === 'number' ? message.requestId : 0;
    const refresh = 'refresh' in message && message.refresh === true;
    const selection = this.controller.snapshot().selection;
    this.catalogAbort?.abort();
    const abort = new AbortController();
    this.catalogAbort = abort;
    this.catalogRequest = requestId;
    const key = this.cacheKey(selection);
    try {
      const models = !refresh && this.modelCache.has(key)
        ? this.modelCache.get(key)!
        : await this.listAvailableModels(selection, abort.signal);
      if (abort.signal.aborted || this.catalogRequest !== requestId) return;
      const current = this.controller.snapshot().selection;
      if (!catalogIsCurrent(
        { requestId, provider: selection.provider, cwd: selection.cwd },
        { requestId: this.catalogRequest, provider: current.provider, cwd: current.cwd },
      )) return;
      this.modelCache.set(key, models);
      this.postCatalog(requestId, current, models);
    } catch (error) {
      if (abort.signal.aborted || this.catalogRequest !== requestId) return;
      const current = this.controller.snapshot().selection;
      if (current.provider !== selection.provider || current.cwd !== selection.cwd) return;
      this.post({
        type: 'modelCatalog', requestId, provider: selection.provider, cwd: selection.cwd, status: 'error',
        error: errorMessage(error), models: [], selectedModelId: current.model, selectedParams: current.modelParams ?? [],
      });
    }
  }

  private async setMenuModel(message: object): Promise<void> {
    const modelId = 'modelId' in message && typeof message.modelId === 'string' ? message.modelId : '';
    await this.applyMenuSelection(async (selection) => {
      const models = await this.cachedModels(selection);
      const chosen = models.find((model) => model.id && (model.id === modelId || model.aliases?.includes(modelId)));
      if (!chosen) throw new Error('モデル一覧に、そのモデルはありません。');
      const next = selectBaseModel(chosen, selection);
      return { next, label: chosen.label, hasDetails: Boolean(chosen.parameters?.length) };
    });
  }

  private async setMenuParam(message: object): Promise<void> {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const value = 'value' in message && typeof message.value === 'string' ? message.value : '';
    if (!id) return;
    await this.applyMenuSelection(async (selection) => {
      const models = await this.cachedModels(selection);
      const model = models.find((item) => matchesModel(item, selection.model));
      const parameter = model?.parameters?.find((item) => item.id === id);
      if (!model || !parameter) return undefined;
      const draft = new ModelSettingsDraft(model, selection.provider, selection.modelParams);
      try { draft.set(parameter, value); } catch { return undefined; }
      const params = draft.params();
      return {
        // draft.set succeeds only after storing the requested parameter, so this list cannot be empty.
        next: { ...selection, modelParams: params },
        label: model.label,
        hasDetails: Boolean(model.parameters?.length),
      };
    });
  }

  private async applyMenuSelection(resolve: (selection: Selection) => Promise<{ next: Selection; label: string; hasDetails: boolean } | undefined>): Promise<void> {
    const target = this.controller;
    const started = target.snapshot();
    if (started.busy) throw new Error('実行が終わってからモデルを選択してください。');
    const selection = started.selection;
    const resolved = await resolve(selection);
    if (!resolved) return;
    if (this.controller !== target) return;
    const current = target.snapshot().selection;
    if (current.provider !== selection.provider || current.cwd !== selection.cwd || current.model !== selection.model
      || !sameModelParams(current.modelParams, selection.modelParams)) return;
    await this.commitModelSelection(resolved.next, {
      model: resolved.next.model, label: resolved.label, hasDetails: resolved.hasDetails,
    }, 'menu');
  }

  private confirmNewSession(): Thenable<boolean> {
    const ja = this.locale === 'ja';
    const label = ja ? '新しいセッションにする' : 'Start new session';
    return vscode.window.showWarningMessage(
      ja
        ? 'この変更は新しいセッションが必要です。現在の会話表示は閉じられ、次の送信から新しいセッションになります。'
        : 'This change needs a new session. The current conversation will close, and the next message starts a new session.',
      { modal: true },
      label,
    ).then((choice) => choice === label);
  }

  private async commitModelSelection(next: Selection, saved: SavedModel, source: 'menu' | 'picker'): Promise<void> {
    const target = this.controller;
    const state = target.snapshot();
    if (state.busy) throw new Error('実行が終わってからモデルを選択してください。');
    const mode = modelApplyMode(next.provider, this.controls[next.provider].backend);
    const unchanged = state.selection.model === next.model && sameModelParams(state.selection.modelParams, next.modelParams);
    if (!unchanged) {
      const conversation = state.messages.some((message) => message.role === 'user' || message.role === 'assistant');
      if (mode === 'new-session' && source === 'menu' && conversation) {
        if (!await this.confirmNewSession()) return;
        if (this.controller !== target) return;
        const latest = target.snapshot();
        if (latest.busy || latest.selection.provider !== next.provider || latest.selection.cwd !== next.cwd
          || latest.selection.model !== state.selection.model || !sameModelParams(latest.selection.modelParams, state.selection.modelParams)) return;
      }
      if (mode === 'next-send') await target.updateSelection(next);
      else await target.select(next);
    }
    if (this.controller !== target) return;
    const stored: SavedModel = {
      model: next.model, label: saved.label, hasDetails: saved.hasDetails,
      ...(next.modelParams ? { modelParams: next.modelParams } : {}),
    };
    this.selectedModels[next.provider] = stored;
    await this.context.workspaceState.update('ai-agents.selectedModels', this.selectedModels);
    this.postState();
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
        picker.items = models.filter((model) => model.id).map((model): ModelItem => ({
          label: model.label, description: model.isDefault ? '推奨' : undefined,
          detail: model.description,
          model,
        }));
        const active = picker.items.find((item) => matchesModel(item.model, selection.model)) ?? picker.items[0];
        picker.activeItems = active ? [active] : [];
        picker.placeholder = models.length ? 'モデルを検索して選択' : 'モデルが見つかりません。再取得してください';
      } catch (error) {
        if (request.signal.aborted) return;
        picker.items = [];
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
      await this.commitModelSelection(next, {
        model: next.model, label: chosen.label, hasDetails: Boolean(chosen.parameters?.length),
      }, 'picker');
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
      await this.commitModelSelection(next, {
        model: next.model, label: model.label, hasDetails: Boolean(model.parameters?.length),
      }, 'picker');
    } finally {
      request.abort();
      this.detailsEditor = undefined;
      this.detailsRequest = undefined;
    }
  }

  async newChat(): Promise<void> {
    const current = this.controller;
    if (current.snapshot().busy || current.snapshot().messages.length > 0 || current.hasLiveTerminals() || current.hasLiveChildren()) {
      const next = this.makeController(current.snapshot().selection);
      const key = randomUUID();
      this.registry.add({ key, controller: next, mode: this.registry.mode() });
      this.registry.focus(key);
      next.setModePreference(this.registry.mode());
      this.postState();
      return;
    }
    await this.flushHistory();
    await current.reset();
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
    if (text) this.post({ type: 'insert', text, label: this.contextLabel(kind) });
  }

  private fileToken(cwd: string): string {
    const token = activeFileToken(cwd);
    if (!token) return '';
    return `@${token.includes(' ') ? `"${token}"` : token} `;
  }

  private rememberFor(owner: ChatController, summary: SessionSummary): void {
    summary = { ...summary, backend: this.controllerControls.get(owner)?.backend, conversationId: this.conversationIds.get(owner) };
    owner.rememberSession(summary);
    if (owner !== this.controller) this.controller.rememberSession(summary);
  }

  private contextLabel(kind: 'file' | 'selection' | 'problems' | 'git' | 'terminal'): string {
    const ja = this.locale === 'ja';
    if (kind === 'file') return ja ? 'ファイル' : 'File';
    if (kind === 'selection') return ja ? '選択範囲' : 'Selection';
    if (kind === 'problems') return ja ? '問題' : 'Problems';
    if (kind === 'git') return ja ? 'Git 差分' : 'Git diff';
    return ja ? 'ターミナル' : 'Terminal';
  }

  private async deliver(prompt: string, images: ImageAttachment[], forceQueue: boolean, attachments: string[] = [], imagesSpecified = false): Promise<void> {
    const target = this.controller;
    const initial = target.snapshot().selection;
    const initialSession = target.sessionId();
    const mode = this.registry.mode();
    const cwd = initial.cwd;
    const builtin = builtinCommand(prompt);
    if (builtin?.name === 'clear' && !builtin.rest) { await this.newChat(); return; }
    if (builtin?.name === 'compact') {
      const session = target.currentSession();
      if (!session?.compact) throw new Error('このバックエンドはコンテキスト圧縮に対応していません。');
      await session.compact();
      target.notify('コンテキストを圧縮しました。');
      return;
    }
    let text = prompt;
    if (builtin?.name === 'review') {
      const session = target.currentSession();
      if (!builtin.rest && session?.review && capabilitiesFor(target.snapshot().selection.provider, this.controls[target.snapshot().selection.provider].backend).review) {
        await target.review('uncommitted');
        return;
      }
      text = `${builtin.rest || 'Review the current changes.'}\n\n${await gitSummary(cwd)}`;
    } else if (builtin?.name === 'diagnostics') text = `${builtin.rest}\n\n${problemsText(cwd)}`.trim();
    else if (builtin?.name === 'diff') text = `${builtin.rest}\n\n${await gitSummary(cwd)}`.trim();
    else if (builtin?.name === 'terminal') text = `${builtin.rest}\n\n${recentTerminalText()}`.trim();
    const expanded = await expandPrompt(text, cwd, await workspaceCommands(cwd));
    const current = target.snapshot().selection;
    if (current.provider !== initial.provider || current.cwd !== initial.cwd || (initialSession && target.sessionId() !== initialSession)) throw new Error('送信準備中に会話の設定が変更されました。内容を確認して再送してください。');
    const retry = this.retryDraft?.controller === target && this.retryDraft.text === prompt ? this.retryDraft : undefined;
    const extras = {
      ...(retry ? { retryOf: retry.id } : {}),
      displayText: prompt,
      ...(imagesSpecified || images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    const running = this.registry.entries().filter((entry) => entry.controller.snapshot().busy);
    const limit = vscode.workspace.getConfiguration('ai-agents').get<number>('maxBackgroundSessions', 3);
    if (!target.snapshot().busy && running.length >= limit) {
      const titles = running.map((entry) => {
        const id = entry.controller.sessionId();
        const known = id ? entry.controller.snapshot().sessions.find((item) => item.id === id) : undefined;
        return known?.title || entry.controller.snapshot().messages.find((message) => message.role === 'user')?.text.slice(0, 40) || id || 'running';
      });
      throw new Error(`同時に実行できる会話の上限です。どれかを停止してください。（${titles.join(', ')}）`);
    }
    if (forceQueue || target.snapshot().busy) {
      target.enqueue(expanded, extras);
      return;
    }
    const provider = target.snapshot().selection.provider;
    const backend = this.controllerControls.get(target)!.backend;
    const config = vscode.workspace.getConfiguration('ai-agents');
    const launch = provider === 'codex'
      ? codexLaunch(config.get<string>('codex.executablePath') || undefined, [])
      : agentLaunch(config.get<string>('cursor.agentPath'), []);
    const command = [launch.command, ...launch.args].join(' ');
    this.output.appendLine(`[${provider}/${backend}] ${launch.kind}${launch.version ? ` ${launch.version}` : ''} ${command} start`);
    const state = target.snapshot();
    const original = retry ? target.retryInput(retry.id) : undefined;
    if (retry && !original && target.snapshot().messages.find((message) => message.id === retry.id)?.attachments?.length && !images.length && !attachments.length) throw new Error('添付を再指定してから再送してください。元の添付は保存されていません。');
    if (this.retryDraft?.controller === target) this.retryDraft = undefined;
    const retryExtras = original ? { ...original.extras, ...extras } : extras;
    if (original && !imagesSpecified && original.extras?.images?.length) retryExtras.images = original.extras.images;
    await target.send(original?.prompt ?? expanded, retryExtras, { mode, selection: state.selection, intent: inferIntent(mode, state.plan) });
    this.output.appendLine(`[${provider}/${backend}] ${target.snapshot().status}`);
  }

  private async rewindPrompt(message: object, turnId: string, editedText: string): Promise<void> {
    const target = this.targetController(message);
    const state = target.snapshot();
    const turn = state.turns.find((item) => item.id === turnId || item.userMessageId === turnId);
    if (!turn) throw new Error('対象のUserターンが見つかりません。');
    const userId = turn.userMessageId ?? turn.id;
    const user = state.messages.find((item) => item.id === userId && item.role === 'user');
    if (!user) throw new Error('対象のUserメッセージがローカル履歴にありません。');
    const original = target.retryInput(turn.id);
    if (user.attachments?.length && !original) throw new Error('添付の元データが保存されていません。添付を含むターンは巻き戻しできません。');
    if (turn.imageCount && !original?.extras?.images?.length) throw new Error('元画像はローカル履歴に保存されていないため、この保存済みターンは巻き戻せません。');
    const preview = await target.previewRewind(turnId);
    if (this.targetController(message) !== target) throw new Error('巻き戻し確認中に対象の会話が切り替わりました。');
    const japanese = this.locale === 'ja';
    const files = preview.files.length
      ? (japanese ? `\n復元するファイル (${preview.files.length}): ${preview.files.slice(0, 8).join(', ')}${preview.files.length > 8 ? '、ほか' : ''}`
        : `\nFiles to restore (${preview.files.length}): ${preview.files.slice(0, 8).join(', ')}${preview.files.length > 8 ? ', and more' : ''}`)
      : (japanese ? '\n復元するファイル変更はありません。' : '\nNo file changes need restoring.');
    const sourcePrompt = preview.prompt.length > 180 ? `${preview.prompt.slice(0, 180)}…` : preview.prompt;
    const replacementPrompt = editedText.trim().length > 180 ? `${editedText.trim().slice(0, 180)}…` : editedText.trim();
    const body = japanese
      ? `このプロンプトを対象位置で編集し、そこから会話を再実行します。\n元の本文: ${sourcePrompt}\n編集後: ${replacementPrompt}\n対象の古い応答と後続ターン ${Math.max(0, preview.removedTurns - 1)} 件を会話から削除し、対象ターン以降のファイル変更を実行前の状態へ Revert します。${files}\nファイルは現在の状態が保存済みチェックポイントと一致する場合だけ復元します。`
      : `Edit this prompt in place and run the conversation again from here.\nOriginal: ${sourcePrompt}\nReplacement: ${replacementPrompt}\nThe old response and ${Math.max(0, preview.removedTurns - 1)} later turn(s) will be removed; file changes from this turn onward will be reverted to the pre-turn state.${files}\nFiles are restored only when they still match their saved checkpoints.`;
    const confirm = japanese ? '巻き戻して再実行' : 'Rewind and resend';
    const choice = await vscode.window.showWarningMessage(body, { modal: true }, confirm);
    if (choice !== confirm) return;
    if (this.targetController(message) !== target) throw new Error('巻き戻し確認中に対象の会話が切り替わりました。');
    this.requireWorkspace(state.selection.cwd);
    const expanded = await expandPrompt(editedText.trim(), state.selection.cwd, await workspaceCommands(state.selection.cwd));
    const extras = {
      displayText: editedText.trim(),
      ...(original?.extras?.images?.length ? { images: original.extras.images } : {}),
      ...(original?.extras?.attachments?.length ? { attachments: original.extras.attachments } : {}),
    };
    await target.rewindAndSend(turn.id, expanded, extras);
  }

  private async configure(message: object): Promise<void> {
    const target = this.controller;
    const conversation = this.registry.entries().find((entry) => entry.controller === target);
    const provider = target.snapshot().selection.provider;
    const current = this.controls[provider];
    const read = (key: string) => key in message ? (message as Record<string, unknown>)[key] : undefined;
    const mode = read('mode');
    const sandbox = read('sandbox');
    const approval = read('approval');
    const network = read('network');
    const webSearch = read('webSearch');
    const next = normalizeControls(provider, {
      ...current,
      ...(mode === 'agent' || mode === 'plan' || mode === 'ask' ? { mode } : {}),
      ...(typeof sandbox === 'string' ? { sandbox } : {}),
      ...(typeof approval === 'string' ? { approval } : {}),
      ...(typeof network === 'boolean' ? { network } : {}),
      ...(typeof webSearch === 'string' ? { webSearch } : {}),
    });
    if (next.sandbox === 'disabled' && current.sandbox !== 'disabled') {
      const allow = await vscode.window.showWarningMessage('サンドボックスを無効にすると、ファイル変更やコマンドが確認なしで実行される場合があります。この会話の保護を解除しますか？', { modal: true }, '保護を解除する');
      if (allow !== '保護を解除する') return;
    }
    const structural = current.backend !== next.backend || current.sandbox !== next.sandbox || current.approval !== next.approval
      || current.network !== next.network || current.webSearch !== next.webSearch
      || current.additionalDirectories.join('\0') !== next.additionalDirectories.join('\0');
    const modeChanged = current.mode !== next.mode;
    if (this.controller !== target || this.controls[provider] !== current) return;
    if (structural && (target.hasSession() || target.sessionId() || target.snapshot().messages.some((message) => message.role === 'user'))) {
      await target.reset();
      target.notify('設定を変更したため、新しい会話になりました。');
    } else if (modeChanged) {
      const applied = await target.applyMode(next.mode);
      if (!applied && target.hasSession()) {
        await target.reset();
        target.setModePreference(next.mode);
      }
    }
    if (conversation) conversation.mode = next.mode;
    this.controllerControls.set(target, { ...next });
    if (this.controller === target) {
      this.controls[provider] = next;
      await this.context.workspaceState.update('ai-agents.controls', this.controls);
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

  private tokenOf(message: object): string | undefined {
    return 'token' in message && typeof message.token === 'string' ? message.token : undefined;
  }

  private isFront(message: object): boolean {
    const id = 'conversationId' in message && typeof message.conversationId === 'string' ? message.conversationId : '';
    return !id || id === this.registry.frontKey;
  }

  private targetController(message: object): ChatController {
    const id = 'conversationId' in message && typeof message.conversationId === 'string' ? message.conversationId : '';
    return (id && this.registry.get(id)) || this.controller;
  }

  private async resolvePermission(message: object): Promise<void> {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const decision = 'decision' in message ? message.decision : undefined;
    if (decision === 'allow-once' || decision === 'allow-session' || decision === 'deny') this.targetController(message).resolvePermission(id, decision, this.tokenOf(message));
  }

  private resolvePlan(message: object): void {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const decision = 'decision' in message ? message.decision : undefined;
    if (id && (decision === 'accepted' || decision === 'rejected')) this.targetController(message).resolvePlan(id, decision, this.tokenOf(message));
  }

  private resolveQuestion(message: object): void {
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const answers = 'answers' in message && message.answers && typeof message.answers === 'object' ? message.answers as Record<string, string[]> : {};
    if (id) this.targetController(message).resolveAnswers(id, answers, this.tokenOf(message));
  }

  private async buildPlan(message: object): Promise<void> {
    const planId = 'planId' in message && typeof message.planId === 'string' ? message.planId : '';
    const revision = 'revision' in message && typeof message.revision === 'number' ? message.revision : -1;
    const plan = this.controller.snapshot().plan;
    if (plan.phase !== 'ready' || plan.current?.id !== planId || plan.current.revision !== revision) return;
    const provider = this.controller.snapshot().selection.provider;
    const modelId = 'modelId' in message && typeof message.modelId === 'string' ? message.modelId : plan.build?.selection.model ?? '';
    const modelParams = 'modelParams' in message && Array.isArray(message.modelParams)
      ? message.modelParams.flatMap((item) => item && typeof item === 'object' && 'id' in item && 'value' in item && typeof item.id === 'string' && typeof item.value === 'string' ? [{ id: item.id, value: item.value }] : [])
      : plan.build?.selection.modelParams;
    const label = 'label' in message && typeof message.label === 'string' ? message.label : modelId;
    const selection: Selection = {
      ...this.controller.snapshot().selection,
      model: modelId,
      ...(modelParams?.length ? { modelParams } : { modelParams: undefined }),
    };
    const target = this.controller;
    const conversation = this.registry.entries().find((entry) => entry.controller === target)!;
    const previousMode = conversation.mode;
    conversation.mode = 'agent';
    this.controls[provider] = { ...this.controls[provider], mode: 'agent' };
    try {
      await target.build(planId, revision, selection);
    } finally {
      const state = target.snapshot();
      if (state.plan.phase !== 'implemented' && state.plan.phase !== 'building') {
        conversation.mode = previousMode;
        target.setModePreference(previousMode);
        if (this.controller === target) this.controls[provider] = { ...this.controls[provider], mode: previousMode };
      }
      // Publish a model label only after the backend has acknowledged the selection.
      if (this.controller === target && state.selection.model === modelId && sameModelParams(state.selection.modelParams, modelParams)) {
        this.selectedModels[provider] = { model: modelId, label: label || modelId || (this.locale === 'ja' ? 'モデルを選択' : 'Select model'), hasDetails: Boolean(modelParams?.length), ...(modelParams?.length ? { modelParams } : {}) };
      }
      this.controllerControls.set(target, { ...this.controllerControls.get(target)!, mode: conversation.mode });
      await this.context.workspaceState.update('ai-agents.controls', this.controls);
      await this.context.workspaceState.update('ai-agents.selectedModels', this.selectedModels);
      this.postState();
    }
  }

  private async setBuildModel(message: object): Promise<void> {
    const target = this.controller;
    const plan = target.snapshot().plan;
    if (plan.phase !== 'ready' || !plan.current) return;
    const provider = target.snapshot().selection.provider;
    const current = plan.build?.selection ?? target.snapshot().selection;
    if ('type' in message && message.type === 'setBuildModel') {
      const modelId = 'modelId' in message && typeof message.modelId === 'string' ? message.modelId : '';
      const models = await this.cachedModels(current);
      const latest = target.snapshot().plan;
      if (this.controller !== target || latest.phase !== 'ready' || latest.current?.id !== plan.current.id
        || latest.current.revision !== plan.current.revision) return;
      const chosen = modelId ? models.find((model) => model.id === modelId || model.aliases?.includes(modelId)) : undefined;
      if (!chosen) throw new Error('モデル一覧に、そのモデルはありません。');
      const selection = selectBaseModel(chosen, current);
      target.setBuildModel(selection, chosen.label || modelId);
      return;
    }
    const id = 'id' in message && typeof message.id === 'string' ? message.id : '';
    const value = 'value' in message && typeof message.value === 'string' ? message.value : '';
    if (!id) return;
    const params = [...(current.modelParams ?? []).filter((param) => param.id !== id), { id, value }];
    target.setBuildModel({ ...current, modelParams: params }, plan.build?.label);
  }

  private async reviewAll(): Promise<void> {
    const changes = this.controller.snapshot().changes.filter((change) => change.path !== 'turn.diff' && change.path !== 'patch');
    const entries: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
    for (const change of changes) {
      const target = this.resolveInside(change.path);
      if (!target || change.previousText === undefined) continue;
      const baseline = await writeBaselineFile(path.join(this.context.globalStorageUri.fsPath, 'review'), { ...change, path: target, previousText: change.previousText ?? '' });
      entries.push([vscode.Uri.file(target), vscode.Uri.file(baseline), change.kind === 'delete' ? undefined : vscode.Uri.file(target)]);
    }
    if (!entries.length) return;
    try {
      await vscode.commands.executeCommand('vscode.changes', 'AI Agents', entries);
    } catch {
      const first = entries[0];
      if (first?.[1] && first[2]) await vscode.commands.executeCommand('vscode.diff', first[1], first[2], 'AI Agents');
    }
  }

  private async openTerminal(message: object): Promise<void> {
    const processId = 'processId' in message && typeof message.processId === 'string' ? message.processId : '';
    if (!processId) return;
    const controller = this.targetController(message);
    const session = controller.currentSession();
    if (!session?.listBackgroundTerminals) throw new Error('この会話には接続可能なバックグラウンドターミナルがありません。');
    const row = (await session.listBackgroundTerminals()).find((item) => item.processId === processId);
    if (!row) throw new Error('このバックグラウンドターミナルは終了しています。');
    this.terminalViews.open(session, row, this.locale === 'ja');
  }

  private async terminateTerminal(message: object): Promise<void> {
    const processId = 'processId' in message && typeof message.processId === 'string' ? message.processId : '';
    if (!processId) return;
    const controller = this.targetController(message);
    const session = controller.currentSession();
    await session?.terminateBackgroundTerminal?.(processId);
    const listed = await session?.listBackgroundTerminals?.();
    if (listed) controller.setTerminals(listed);
    else this.postState();
  }


  private decorateShell<T extends { changes: { name: string; icon?: { type: 'image' | 'font' | 'badge'; src?: string; badge?: string; fontFamily?: string; fontCharacter?: string; fontColor?: string } }[] }>(shell: T, webview: vscode.Webview): T {
    return { ...shell, changes: shell.changes.map((change) => ({ ...change, icon: this.iconFor(webview, change.name) })) };
  }

  private decorateMessages(messages: ViewMessage[], webview: vscode.Webview): ViewMessage[] {
    return messages.map((message) => {
      const meta = message.meta;
      const files = meta?.files;
      if (!meta || !files?.length) return message;
      return { ...message, meta: { ...meta, files: files.map((file) => ({ ...file, icon: this.iconFor(webview, file.path) })) } };
    });
  }

  private iconFor(webview: vscode.Webview, fileName: string): { type: 'image' | 'font' | 'badge'; src?: string; badge?: string; fontFamily?: string; fontCharacter?: string; fontColor?: string } {
    void this.ensureIconTheme();
    const variant = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light'
      : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast ? 'highContrast' : 'dark';
    if (!this.iconTheme || !this.iconThemeDir) return { type: 'badge', badge: extensionBadge(fileName) };
    const match = resolveThemeIcon(this.iconTheme, fileName, variant);
    if (match.type === 'image') {
      return { type: 'image', src: webview.asWebviewUri(vscode.Uri.joinPath(this.iconThemeDir, match.iconPath)).toString() };
    }
    if (match.type === 'font' && match.fontCharacter) {
      const src = match.fontPath ? webview.asWebviewUri(vscode.Uri.joinPath(this.iconThemeDir, match.fontPath)).toString() : undefined;
      return { type: 'font', ...(src ? { src } : {}), badge: extensionBadge(fileName), fontFamily: match.fontFamily, fontCharacter: match.fontCharacter, ...(match.fontColor ? { fontColor: match.fontColor } : {}) };
    }
    return { type: 'badge', badge: extensionBadge(fileName) };
  }

  private async ensureIconTheme(): Promise<void> {
    const id = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme', '');
    const variant = vscode.window.activeColorTheme.kind;
    const key = `${id}:${variant}`;
    if (!id || this.iconThemeKey === key) return;
    this.iconThemeKey = key;
    for (const extension of vscode.extensions.all) {
      const themes = extension.packageJSON?.contributes?.iconThemes;
      if (!Array.isArray(themes)) continue;
      const match = themes.find((theme) => theme && typeof theme === 'object' && 'id' in theme && theme.id === id) as { path?: string } | undefined;
      if (!match?.path) continue;
      try {
        const uri = vscode.Uri.joinPath(extension.extensionUri, match.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.iconTheme = JSON.parse(new TextDecoder().decode(bytes)) as IconThemeDocument;
        this.iconThemeDir = vscode.Uri.joinPath(uri, '..');
        for (const view of this.views) {
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'), extension.extensionUri],
          };
        }
        this.postState();
      } catch {
        this.iconTheme = undefined;
        this.iconThemeDir = undefined;
      }
      return;
    }
  }

  private async reviewFile(type: string, filePath: unknown, line?: unknown, column?: unknown, endLine?: unknown): Promise<void> {
    if (typeof filePath !== 'string' || !filePath) return;
    const roots = this.folders().map((folder) => folder.path);
    const change = this.controller.snapshot().changes.find((item) => item.path === filePath);
    const synthetic = filePath === 'turn.diff' || filePath === 'patch' || path.basename(filePath) === 'turn.diff';
    if (type === 'openFile') {
      const target = /^file:\/\//i.test(filePath) ? vscode.Uri.parse(filePath).fsPath : filePath;
      const resolved = this.resolveInside(target);
      if (!resolved) throw new Error('ワークスペース外のファイルは変更できません。');
      await this.openInEditor(resolved, line, column, endLine);
      return;
    }
    if (!change || synthetic) {
      if (change?.diff) this.post({ type: 'inspector', title: path.basename(filePath), text: change.diff.slice(0, 8000) });
      return;
    }
    if (type === 'revertFile') {
      await revertChange(change, roots);
      this.controller.notify(`Reverted ${path.basename(filePath)}`);
      return;
    }
    const target = this.resolveInside(change.path);
    if (!target) return;
    if (change.previousText === undefined) {
      await this.openInEditor(target);
      return;
    }
    const baseline = await writeBaselineFile(path.join(this.context.globalStorageUri.fsPath, 'review'), { ...change, path: target, previousText: change.previousText ?? '' });
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(baseline), vscode.Uri.file(target), `${path.basename(target)}: before ↔ current`);
  }

  private async openInEditor(file: string, line?: unknown, column?: unknown, endLine?: unknown): Promise<void> {
    const uri = vscode.Uri.file(file);
    if (binaryFile(file)) {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    try {
      const editor = await vscode.window.showTextDocument(uri, { preview: true });
      const lineNumber = typeof line === 'number' ? line : Number(line);
      const columnNumber = typeof column === 'number' ? column : Number(column);
      if (Number.isSafeInteger(lineNumber) && lineNumber > 0) {
        const firstLine = Math.min(lineNumber, editor.document.lineCount);
        const startLine = firstLine - 1;
        const endNumber = typeof endLine === 'number' ? endLine : Number(endLine);
        const lastLine = Number.isSafeInteger(endNumber) && endNumber >= lineNumber ? Math.min(endNumber, editor.document.lineCount) : firstLine;
        const start = new vscode.Position(startLine, Number.isSafeInteger(columnNumber) && columnNumber > 0 ? columnNumber - 1 : 0);
        const end = Number.isSafeInteger(columnNumber) && columnNumber > 0
          ? start
          : new vscode.Position(lastLine - 1, editor.document.lineAt(lastLine - 1).text.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end));
      }
    } catch (error) {
      if (!binaryTextError(error)) throw error;
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private resolveInside(filePath: string): string | undefined {
    const roots = this.folders().map((folder) => folder.path);
    const cwd = this.controller.snapshot().selection.cwd;
    const candidate = path.isAbsolute(filePath) ? filePath : cwd ? path.resolve(cwd, filePath) : '';
    if (!candidate || !roots.some((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    })) return undefined;
    return candidate;
  }

  private async restoreSession(id: unknown): Promise<void> {
    if (typeof id !== 'string') return;
    await this.historyReady;
    if (id === this.controller.sessionId()) return;
    const provider = this.controller.snapshot().selection.provider;
    const summary = mergeRegistrySessions(this.controller.snapshot().sessions, this.registry.liveSummaries())
      .find((session) => (session.id === id || session.conversationId === id) && session.provider === provider);
    if (!summary) return;
    const existing = this.registry.entries().find((entry) => entry.controller.sessionId() === summary.id && entry.controller.snapshot().selection.provider === provider && (!summary.conversationId || this.conversationIds.get(entry.controller) === summary.conversationId));
    if (existing) {
      this.controls[provider] = this.controllerControls.get(existing.controller)!;
      this.registry.focus(existing.key);
      existing.controller.setModePreference(existing.mode);
      await existing.controller.currentSession()?.listBackgroundTerminals?.().catch(() => undefined);
      this.postState();
      return;
    }
    if (summary.backend !== 'cli') {
      this.controller.notify('CLI で作成されたことを確認できない履歴は再開できません。元の履歴は保持されています。');
      return;
    }
    const selection = { ...this.controller.snapshot().selection, cwd: summary.cwd ?? this.controller.snapshot().selection.cwd };
    this.requireWorkspace(selection.cwd);
    const target = this.makeController(selection);
    const key = randomUUID();
    this.registry.add({ key, controller: target, mode: this.controls[provider].mode });
    this.registry.focus(key);
    target.setModePreference(this.registry.mode());
    const record = this.displayHistory.get(summary.id) ?? (summary.conversationId ? this.displayHistory.get(summary.conversationId) : undefined);
    if (record && !record.sessionId) {
      target.restoreSnapshot(record.state);
      target.notify(this.locale === 'ja'
        ? 'この履歴は表示専用です。バックエンドの会話は再開していません。'
        : 'This history is display-only. The backend conversation was not resumed.');
      this.postState();
      return;
    }
    target.prepareResume(summary.id);
    await target.openSession();
    this.applyRestoredDisplay(target, record, summary.id);
    this.postState();
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

  private async removeDirectory(folder: string): Promise<void> {
    const provider = this.controller.snapshot().selection.provider;
    const current = this.controls[provider];
    if (!current.additionalDirectories.includes(folder)) return;
    this.controls[provider] = { ...current, additionalDirectories: current.additionalDirectories.filter((item) => item !== folder) };
    await this.context.workspaceState.update('ai-agents.controls', this.controls);
    if (this.controller.hasSession()) {
      await this.controller.reset();
      this.controller.notify(this.locale === 'ja' ? '設定を変更したため、新しい会話になりました。' : 'Started a new conversation because the execution settings changed.');
    }
    this.postState();
  }

  private async refreshSessions(): Promise<void> {
    const selection = this.controller.snapshot().selection;
    const previous = this.controller.snapshot().sessions;
    let listed: SessionSummary[] | undefined;
    try {
      const current = this.controller.currentSession();
      listed = current?.listSessions
        ? await current.listSessions()
        : selection.cwd ? await this.probeSessions(selection) : [];
    } catch (error) {
      this.output.appendLine(errorMessage(error));
    }
    const sessions = (listed ?? previous).map((session) => ({ ...session, backend: session.backend ?? 'cli' as const }));
    const stored = this.displayHistory.summaries().filter((item) => item.provider === selection.provider && (!selection.cwd || item.cwd === selection.cwd));
    const merged = mergeRegistrySessions(sessions, this.registry.liveSummaries());
    this.controller.replaceSessions(stored.length ? mergeRegistrySessions(merged, stored) : merged);
  }

  async showDiagnostics(): Promise<void> {
    const selection = this.controller.snapshot().selection;
    const config = vscode.workspace.getConfiguration('ai-agents');
    const checks = [];
    checks.push({ label: 'Extension host', ok: true, output: `node ${process.versions.node}` });
    if (selection.provider === 'cursor') {
      const launch = agentLaunch(config.get<string>('cursor.agentPath'), []);
      const version = await runProcess(launch.command, ['--version'], selection.cwd || undefined);
      checks.push({ ...version, label: `Cursor CLI (${launch.kind}) ${launch.command}` });
      checks.push(await runProcess(launch.command, ['status'], selection.cwd || undefined));
    } else {
      const launch = codexLaunch(config.get<string>('codex.executablePath') || undefined, []);
      const version = await runProcess(launch.command, [...launch.args, '--version'], selection.cwd || undefined);
      checks.push({ ...version, label: `Codex CLI (${launch.kind})` });
    }
    const backend = this.controls[selection.provider].backend;
    checks.push({ label: 'Backend', ok: true, output: `${selection.provider}/${backend}` });
    this.post({ type: 'inspector', title: 'Diagnostics', text: checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.label}\n${check.output}`).join('\n\n') });
  }

  async openPanel(panel: 'history' | 'settings' | 'chat'): Promise<void> {
    const visible = [...this.views].find((view) => view.visible);
    await vscode.commands.executeCommand(visible?.viewType === 'ai-agents.secondaryChat' ? 'ai-agents.secondaryChat.focus' : 'ai-agents.chat.focus');
    this.post({ type: 'navigate', panel });
  }

  async signIn(): Promise<void> {
    const provider = this.controller.snapshot().selection.provider;
    if (provider === 'cursor') {
      const launch = agentLaunch(vscode.workspace.getConfiguration('ai-agents').get<string>('cursor.agentPath'), ['login']);
      const terminal = vscode.window.createTerminal('Cursor CLI Login');
      terminal.sendText(terminalCommand(launch.command, launch.args));
      terminal.show();
      return;
    }
    {
      const terminal = vscode.window.createTerminal('Codex Login');
      terminal.sendText('codex login');
      terminal.show();
    }
  }

  async setApiKey(): Promise<void> {
    await vscode.commands.executeCommand(this.controller.snapshot().selection.provider === 'cursor'
      ? 'ai-agents.setCursorApiKey' : 'ai-agents.setCodexApiKey');
  }

  async showUsage(): Promise<void> {
    const usage = this.controller.snapshot().usage;
    const limits = await this.controller.currentSession()?.rateLimits?.().catch((error: unknown) => errorMessage(error)) ?? '';
    const selection = this.controller.snapshot().selection;
    const backend = this.controls[selection.provider].backend;
    const text = [usageText(usage, backend === 'acp' || (selection.provider === 'cursor' && backend === 'cli') ? '非対応 / Unsupported' : '未取得 / Not reported'), usage ? JSON.stringify(usage, null, 2) : '', limits].filter(Boolean).join('\n');
    this.post({ type: 'inspector', title: 'Usage', text });
  }

  async showInstructions(): Promise<void> {
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
    this.terminalViews.dispose();
    await this.flushHistory();
    this.historyPaused = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.modelRequest?.abort();
    this.modelPicker?.hide();
    this.detailsRequest?.abort();
    this.detailsEditor?.hide();
    await Promise.all(this.registry.entries().map((entry) => entry.controller.dispose()));
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name));
    return `<!DOCTYPE html>
<html lang="${this.locale === 'ja' ? 'ja' : 'en'}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('codicon.css')}"><link rel="stylesheet" href="${asset('main.css')}"><title>AI Agents</title>
</head><body><div id="app"></div>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body></html>`;
  }
}

function terminalCommand(command: string, args: string[]): string {
  const quote = (part: string) => /^[\w./:@+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`;
  return [command, ...args].map(quote).join(' ');
}

const binaryExtension = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|mp3|mp4|mov|webm|wav|icns)$/i;

function binaryFile(file: string): boolean {
  return binaryExtension.test(file);
}

function binaryTextError(error: unknown): boolean {
  return /binary and cannot be opened as text/i.test(errorMessage(error));
}
