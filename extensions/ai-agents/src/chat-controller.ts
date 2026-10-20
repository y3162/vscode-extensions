import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { refreshChangeStats } from './change-tracker.js';
import { sanitizeImages } from './images.js';
import { sameModelParams } from './model-settings.js';
import { applyPlanTodos, beginPlanning, buildPrompt, cloneSelection, commitDraft, finishBuild, inferIntent, planningFailed, requestBuild, setBuildSelection, stageDraft } from './plan-state.js';
import { upsertSession } from './session-index.js';
import { usageDifference } from './usage.js';
import { addUsage, lightMeta } from './providers/details.js';
import { mergeFileChanges } from './change-review.js';
import { lineChangeCounts } from './diff-stats.js';
import {
  buildTurnRewindPlan, discardTurnRewindJournal, prepareTurnRewindJournal, readSafeWorkspaceFile,
  restoreTurnRewindFiles, rollbackTurnRewindJournal, workspaceRelativePath, type TurnRewindPlan,
} from './turn-rewind.js';
import {
  emptyPlanState, errorMessage, redactSecrets, type AgentInteractions, type AgentMode, type AgentSession, type AgentUpdate, type ChatMessage,
  type ChatState, type ConnectionStatus, type FileChange, type PermissionDecision, type PermissionRequest, type PlanRequest, type PlanState,
  type QuestionRequest, type QueuedPrompt, type Selection, type SendExtras, type SessionSummary, type TerminalRecord, type TurnFileSnapshot, type TurnOptions, type TurnRecord,
} from './types.js';

type SessionFactory = (selection: Selection, context?: { signal?: AbortSignal; resumeId?: string }) => Promise<AgentSession>;

export interface RewindPersistence {
  journalDirectory: string;
  conversationId(): string | undefined;
  enabled(): boolean;
  flush(): Promise<void>;
}

interface TurnFileObservation {
  rawPaths: string[];
  finalFiles?: FileChange[];
}

export interface RewindPreview {
  targetId: string;
  prompt: string;
  removedTurns: number;
  files: string[];
}

interface PermissionWait { request: PermissionRequest; token: string; resolve: (decision: PermissionDecision) => void }
interface PlanWait { request: PlanRequest; token: string; resolve: (decision: 'accepted' | 'rejected') => void }
interface QuestionWait { request: QuestionRequest; token: string; resolve: (answers: Record<string, string[]>) => void }

function restoreQueue(value: unknown): { items: QueuedPrompt[]; dropped: number; imagesDropped: boolean } {
  if (!Array.isArray(value)) return { items: [], dropped: 0, imagesDropped: false };
  const items: QueuedPrompt[] = [];
  let dropped = 0;
  let imagesDropped = false;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped += 1; continue; }
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.text !== 'string' || record.text.length > 100000) { dropped += 1; continue; }
    let extras: SendExtras | undefined;
    if (record.extras !== undefined) {
      if (!record.extras || typeof record.extras !== 'object' || Array.isArray(record.extras)) { dropped += 1; continue; }
      const rawExtras = record.extras as Record<string, unknown>;
      const next: SendExtras = {};
      if (typeof rawExtras.retryOf === 'string') next.retryOf = rawExtras.retryOf.slice(0, 200);
      if (typeof rawExtras.displayText === 'string') next.displayText = rawExtras.displayText.slice(0, 100000);
      if (Array.isArray(rawExtras.attachments)) next.attachments = rawExtras.attachments.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 200));
      if (Object.hasOwn(rawExtras, 'images')) {
        try { next.images = sanitizeImages(rawExtras.images); }
        catch { dropped += 1; imagesDropped = true; continue; }
      }
      if (Object.keys(next).length) extras = next;
    }
    if (!record.text.trim() && !extras?.images?.length) { dropped += 1; continue; }
    items.push({ id: record.id.slice(0, 200), text: record.text, ...(extras ? { extras } : {}) });
  }
  return { items, dropped, imagesDropped };
}

export class ChatController {
  private session?: AgentSession;
  private readonly retryInputs = new Map<string, { prompt: string; extras?: SendExtras }>();
  private restored = false;
  private usageBaselineUnknown = false;
  private unsubscribeBackground?: () => void;
  private readonly updateTurns = new Map<string, string>();
  private readonly fileObservations = new Map<string, TurnFileObservation>();
  private workspaceRealPath?: string;
  private active?: { abort: AbortController; done: Promise<void> };
  private resetting?: Promise<void>;
  private changingModel = false;
  private rewinding = false;
  private rewindSending = false;
  private modelChangeDone?: Promise<void>;
  private autoDrain = false;
  private queueTail: Promise<void> = Promise.resolve();
  private replayed = false;
  private retainedId?: string;
  private readonly allowSession: { kind: string; title: string; detail: string }[] = [];
  private permissionWait: PermissionWait | null = null;
  private readonly permissionQueue: PermissionWait[] = [];
  private planWait: PlanWait | null = null;
  private questionWait: QuestionWait | null = null;
  private modePreference: AgentMode = 'agent';
  private currentTurn?: string;
  private turnWait = 0;
  private waitStarted?: number;
  private readonly state: ChatState;
  readonly interactions: AgentInteractions;

  constructor(
    selection: Selection,
    private readonly factory: SessionFactory,
    private readonly changed: (state: ChatState) => void,
    private readonly rewindPersistence?: RewindPersistence,
  ) {
    this.state = {
      selection: { ...selection }, busy: false, messages: [], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    };
    this.interactions = {
      requestPermission: (request) => this.requestPermission(request),
      requestPlan: (request) => this.requestPlan(request),
      requestAnswers: (request) => this.requestAnswers(request),
    };
  }

  snapshot(): ChatState { return structuredClone(this.state); }
  hasSession(): boolean { return Boolean(this.session); }
  currentSession(): AgentSession | undefined { return this.session; }
  sessionId(): string | undefined { return this.session?.sessionId || this.retainedId; }
  setModePreference(mode: AgentMode): void { this.modePreference = mode; }
  prepareResume(id: string): void { this.retainedId = id; this.usageBaselineUnknown = true; }
  planSnapshot(): PlanState { return structuredClone(this.state.plan); }

  async previewRewind(targetId: string): Promise<RewindPreview> {
    const { turn, plan } = await this.preflightRewind(targetId);
    const userId = turn.userMessageId ?? turn.id;
    const user = this.state.messages.find((message) => message.id === userId && message.role === 'user');
    if (!user) throw new Error('The selected user message is missing from local history.');
    return { targetId: turn.id, prompt: user.text, removedTurns: plan.removedTurns, files: plan.files.map((file) => file.path) };
  }

  async rewindAndSend(targetId: string, editedText: string, extras?: SendExtras): Promise<void> {
    editedText = editedText.trim();
    if (!editedText && !extras?.images?.length) return;
    if (editedText.length > 100000) throw new Error('依頼は100,000文字以内で入力してください。');
    if (this.rewinding) throw new Error('巻き戻し処理は既に実行中です。');
    if (!this.rewindPersistence?.enabled()) throw new Error('ローカル履歴の保存が無効なため、安全な巻き戻しを実行できません。');
    this.rewinding = true;
    this.autoDrain = false;
    this.state.busy = true;
    this.state.status = 'restoring';
    this.state.operationLabel = 'rewind-check';
    this.publish();

    let oldState: ChatState | undefined;
    let oldSession: AgentSession | undefined;
    let branchSession: AgentSession | undefined;
    let oldBackendSessionId: string | undefined;
    let oldRetainedId: string | undefined;
    let oldUnsubscribe: (() => void) | undefined;
    let journal: Awaited<ReturnType<typeof prepareTurnRewindJournal>> | undefined;
    let switched = false;
    try {
      const { turn, targetIndex, plan, session: currentSession, backendTurnId, forkBeforeTurn } = await this.preflightRewind(targetId, true);
      const oldTurns = this.state.turns.slice();
      const removedTurns = oldTurns.slice(targetIndex);
      const userId = turn.userMessageId ?? turn.id;
      const userMessageIndex = this.state.messages.findIndex((message) => message.id === userId && message.role === 'user');
      if (userMessageIndex < 0) throw new Error('The selected user message is missing from local history.');
      oldSession = currentSession;
      oldBackendSessionId = currentSession.sessionId;
      oldRetainedId = this.retainedId;
      oldUnsubscribe = this.unsubscribeBackground;
      oldState = structuredClone(this.state);

      this.state.operationLabel = 'rewind-branch';
      this.publish();
      const branchId = await forkBeforeTurn.call(currentSession, backendTurnId);
      if (!branchId || branchId === currentSession.sessionId) throw new Error('The backend did not create a separate conversation branch.');
      if (currentSession.activateFork) {
        currentSession.activateFork(branchId);
        branchSession = currentSession;
      } else {
        branchSession = await this.factory(cloneSelection(this.state.selection), { resumeId: branchId });
      }
      if (branchSession.sessionId !== branchId || branchSession.closed) throw new Error('The new Codex branch could not be opened safely.');
      if (!branchSession.listBackgroundTerminals) throw new Error('Background Terminal の状態を確認できないため、安全に巻き戻せません。');
      const branchTerminals = await branchSession.listBackgroundTerminals();
      if (branchTerminals?.some((terminal) => !terminal.status || !/complete|exit|done|terminat|kill|dead|fail|cancel|abort|succeed/i.test(terminal.status))) {
        throw new Error('The new branch reports a live background terminal. Rewind was cancelled.');
      }

      const conversationId = this.rewindPersistence.conversationId();
      if (!conversationId) throw new Error('The local conversation id is not available for a recoverable rewind.');
      const trimmed = await this.trimmedState(targetIndex, userMessageIndex, plan, branchTerminals ?? []);
      journal = await prepareTurnRewindJournal(this.rewindPersistence.journalDirectory, conversationId, branchId, this.state.selection.cwd, plan);
      this.state.operationLabel = 'rewind-files';
      this.publish();
      await restoreTurnRewindFiles(journal.journal);

      switched = true;
      Object.assign(this.state, trimmed);
      this.session = branchSession;
      this.retainedId = branchId;
      this.unsubscribeBackground?.();
      this.unsubscribeBackground = this.bindSession(branchSession);
      this.replayed = true;
      this.updateTurns.clear();
      this.currentTurn = undefined;
      for (const removed of removedTurns) {
        this.retryInputs.delete(removed.id);
        this.fileObservations.delete(removed.id);
      }
      this.state.busy = true;
      this.state.status = 'restoring';
      this.state.operationLabel = 'rewind-prepare';
      this.publish();
      await this.rewindPersistence.flush();
      await discardTurnRewindJournal(journal.path).catch(() => {});

      this.rewindSending = true;
      this.state.operationLabel = 'rewind-send';
      this.publish();
      await this.send(editedText, extras, {
        intent: turn.intent,
        mode: turn.mode,
        selection: cloneSelection(this.state.selection),
      });
      if (oldSession !== branchSession) void oldSession.dispose().catch(() => {});
    } catch (error) {
      this.rewindSending = false;
      let recoveryError: unknown;
      if (journal && !switched) {
        try {
          await rollbackTurnRewindJournal(journal.journal);
          await discardTurnRewindJournal(journal.path);
        } catch (rollbackError) { recoveryError = rollbackError; }
      }
      if (switched && oldState && oldSession) {
        this.unsubscribeBackground?.();
        if (oldSession.activateFork && oldBackendSessionId && oldSession.sessionId !== oldBackendSessionId) oldSession.activateFork(oldBackendSessionId);
        this.session = oldSession;
        this.retainedId = oldRetainedId;
        this.unsubscribeBackground = this.bindSession(oldSession);
        Object.assign(this.state, oldState);
        if (branchSession && branchSession !== oldSession) await branchSession.dispose().catch(() => {});
        if (journal) {
          try {
            await rollbackTurnRewindJournal(journal.journal);
            await discardTurnRewindJournal(journal.path);
          } catch (rollbackError) { recoveryError = rollbackError; }
        }
        await this.rewindPersistence.flush().catch(() => {});
      } else {
        if (oldSession?.activateFork && oldBackendSessionId && oldSession.sessionId !== oldBackendSessionId) oldSession.activateFork(oldBackendSessionId);
        if (branchSession && branchSession !== oldSession) await branchSession.dispose().catch(() => {});
      }
      if (recoveryError) throw new Error(`${errorMessage(error)}\nファイルまたはジャーナルの復旧に失敗しました。ジャーナルは自動復旧用に保持されています: ${errorMessage(recoveryError)}`);
      throw error;
    } finally {
      this.rewindSending = false;
      this.rewinding = false;
      this.state.busy = Boolean(this.active || this.resetting);
      this.state.operationLabel = undefined;
      if (!this.state.busy && this.state.status === 'restoring') this.state.status = 'idle';
      this.publish();
    }
  }

  restoreSnapshot(saved: ChatState, id?: string): void {
    if (this.rewinding) return;
    const sessions = this.state.sessions;
    const restoredQueue = restoreQueue(saved.queue);
    Object.assign(this.state, structuredClone(saved), { busy: false, queue: restoredQueue.items, pendingPermission: null, pendingPlan: null, pendingQuestion: null, autoApprove: false, sessions });
    // Restored queue items remain visible for explicit user action; they are never replayed automatically.
    this.autoDrain = false;
    this.state.messages = this.state.messages.map((message) => this.sanitizeSubagentMessage(message));
    for (const child of this.state.subagents) {
      const task = child.task ? redactSecrets(child.task) : undefined;
      const progress = child.progress ? redactSecrets(child.progress) : undefined;
      const result = child.resultPreview ? redactSecrets(child.resultPreview) : undefined;
      const error = child.error ? redactSecrets(child.error) : undefined;
      child.task = task?.slice(0, 12000);
      child.taskOmitted ||= Boolean(task && task.length > 12000);
      child.progress = progress?.slice(0, 180);
      child.resultPreview = result?.slice(0, 500);
      child.error = error?.slice(0, 4000);
      this.trimSubagentHistory(child.id);
    }
    this.retainedId = id;
    this.state.subagentWaiting = undefined;
    this.restored = true;
    this.state.status = 'idle';
    for (const turn of this.state.turns) if (turn.status === 'running') {
      turn.status = 'unknown';
      delete turn.endedAt;
    }
    for (const child of this.state.subagents) if (child.status === 'running') child.status = 'unknown';
    for (const terminal of this.state.terminals) {
      if (!terminal.status || !/complete|exit|done|terminat|kill|dead|fail|cancel|abort|succeed/i.test(terminal.status)) terminal.status = 'unknown';
    }
    if (restoredQueue.dropped) this.state.messages.push({
      id: randomUUID(), role: 'status', at: Date.now(),
      text: restoredQueue.imagesDropped
        ? '履歴内の画像Queueを安全に復元できなかったため除外しました。画像を再添付してください。 / A queued request with an unavailable image was not restored. Reattach the image before sending.'
        : '履歴内の未送信Queueを安全に復元できなかったため除外しました。 / Some unsent queued requests could not be restored safely.',
    });
    if (this.state.plan.phase === 'planning' || this.state.plan.phase === 'revising' || this.state.plan.phase === 'building') {
      this.state.plan = { ...this.state.plan, phase: 'unknown' };
    }
    this.publish();
  }

  retryInput(id: string): { prompt: string; extras?: SendExtras } | undefined { return this.retryInputs.get(id); }

  rewindableTurnIds(): Set<string> {
    if (!this.rewindPersistence?.enabled() || this.state.busy || this.state.queue.length || this.hasLiveChildren() || this.hasLiveTerminals()) return new Set();
    let suffixIsSafe = true;
    const ids = new Set<string>();
    for (const turn of [...this.state.turns].reverse()) {
      const safe = turn.status === 'completed' && Boolean(turn.backendTurnId) && Boolean(turn.planBefore) && Boolean(turn.todosBefore)
        && !turn.userMessageId && turn.fileCheckpoint?.status === 'captured';
      suffixIsSafe = suffixIsSafe && safe;
      if (suffixIsSafe) ids.add(turn.id);
    }
    return ids;
  }

  private async preflightRewind(targetId: string, operationOwnsBusy = false): Promise<{
    turn: TurnRecord;
    targetIndex: number;
    plan: TurnRewindPlan;
    session: AgentSession;
    backendTurnId: string;
    forkBeforeTurn: NonNullable<AgentSession['forkBeforeTurn']>;
  }> {
    if (!this.rewindPersistence?.enabled()) throw new Error('ローカル履歴の保存が無効なため、安全な巻き戻しを実行できません。');
    if (this.active || this.resetting || this.changingModel || this.state.busy && !operationOwnsBusy) throw new Error('実行中の会話は巻き戻せません。');
    if (this.state.queue.length || this.permissionWait || this.planWait || this.questionWait) throw new Error('Queue または保留中の操作を解決してから巻き戻してください。');
    if (this.state.plan.phase === 'planning' || this.state.plan.phase === 'revising' || this.state.plan.phase === 'building') throw new Error('Plan / Build の処理中は巻き戻せません。');
    if (this.hasLiveChildren() || this.state.subagents.some((child) => !child.parentTurnId)) throw new Error('稼働中または対象ターンが特定できない子エージェントがあります。');
    if (this.hasLiveTerminals()) throw new Error('稼働中または状態を確認できない Background Terminal があります。');
    if (!this.session && !this.retainedId) throw new Error('このローカル履歴には再開できる Backend セッションがありません。');
    if (!this.session) await this.openAgent();
    // openAgent either assigns a session or throws; a retained id alone is never treated as a live session.
    const session = this.session!;
    const forkBeforeTurn = session.forkBeforeTurn;
    if (!forkBeforeTurn) throw new Error(session.rewindUnsupportedReason?.() || 'この Backend は過去ターンへの安全な分岐に対応していません。');
    const unsupported = session.rewindUnsupportedReason?.();
    if (unsupported) throw new Error(unsupported);
    if (!session.listBackgroundTerminals) throw new Error('Background Terminal の状態を確認できないため、安全に巻き戻せません。');
    this.state.terminals = await session.listBackgroundTerminals();
    if (this.hasLiveTerminals()) throw new Error('稼働中または状態を確認できない Background Terminal があります。');
    const matches = this.state.turns.flatMap((turn, index) => turn.id === targetId || turn.userMessageId === targetId ? [{ turn, index }] : []);
    if (matches.length !== 1) throw new Error('対象の User ターンを一意に特定できません。');
    const { turn, index: targetIndex } = matches[0]!;
    if (!turn.backendTurnId) throw new Error('対象ターンの Backend turn ID が保存されていません。');
    const backendTurnId = turn.backendTurnId;
    for (const later of this.state.turns.slice(targetIndex)) {
      if (!later.backendTurnId) throw new Error('後続ターンの Backend turn ID が不足しています。');
      if (!later.planBefore || !later.todosBefore) throw new Error('後続ターンの Plan / Todo チェックポイントが不足しています。');
    }
    await this.rewindPersistence.flush();
    const plan = await buildTurnRewindPlan(this.state.turns, turn.id, this.state.selection.cwd);
    return { turn, targetIndex, plan, session, backendTurnId, forkBeforeTurn };
  }

  private async captureTurnFileCheckpoint(turnId: string): Promise<void> {
    const turn = this.state.turns.find((item) => item.id === turnId);
    if (!turn) return;
    const session = this.session;
    if (!session?.forkBeforeTurn) return;
    turn.backendTurnId ??= session.latestBackendTurnId?.();
    const root = this.workspaceRealPath;
    const unsupported = (reason: string): void => {
      // This method only runs from send() after openAgent() has resolved the workspace path.
      turn.fileCheckpoint = { status: 'unsupported', workspaceRoot: root!, files: [], reason };
    };
    try {
      const reason = session.rewindUnsupportedReason?.();
      if (reason) { unsupported(reason); this.publish(); return; }
      const observation = this.fileObservations.get(turnId);
      if (!root || !observation?.finalFiles) { unsupported('Codex did not provide a complete per-turn workspace baseline.'); this.publish(); return; }
      const finalPaths = new Set<string>();
      const snapshots: TurnFileSnapshot[] = [];
      let bytes = 0;
      for (const change of observation.finalFiles) {
        if (change.kind === 'rename' || change.oldPath) { unsupported('Rename operations are not yet supported by safe turn rewind.'); this.publish(); return; }
        if (change.previousText === undefined || change.previousMode === undefined) { unsupported(`The before-state of ${change.path} is incomplete.`); this.publish(); return; }
        const relative = workspaceRelativePath(root, change.path);
        finalPaths.add(relative);
        const after = await readSafeWorkspaceFile(root, relative);
        if ((change.previousText === null) !== (change.previousMode === null)) { unsupported(`The text and mode baselines disagree for ${relative}.`); this.publish(); return; }
        snapshots.push({ path: relative, beforeText: change.previousText, afterText: after.text, beforeMode: change.previousMode, afterMode: after.mode });
        bytes += Buffer.byteLength(change.previousText ?? '') + Buffer.byteLength(after.text ?? '');
      }
      for (const raw of observation.rawPaths) {
        const relative = workspaceRelativePath(root, raw);
        if (!finalPaths.has(relative)) { unsupported(`Codex reported ${relative} but did not provide a complete before-state.`); this.publish(); return; }
      }
      if (bytes > 2_000_000) { unsupported('This turn exceeds the safe checkpoint size limit.'); this.publish(); return; }
      const priorBytes = this.state.turns.filter((item) => item.id !== turnId).reduce((total, item) => total + (item.fileCheckpoint?.files ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.beforeText ?? '') + Buffer.byteLength(file.afterText ?? ''), 0), 0);
      if (priorBytes + bytes > 8_000_000) { unsupported('This conversation exceeds the safe checkpoint storage limit.'); this.publish(); return; }
      turn.fileCheckpoint = { status: 'captured', workspaceRoot: root, files: snapshots };
    } catch (error) {
      unsupported(errorMessage(error));
    }
    this.publish();
  }

  private async trimmedState(targetIndex: number, userIndex: number, plan: TurnRewindPlan, terminals: TerminalRecord[]): Promise<Partial<ChatState>> {
    // preflightRewind validates every turn from targetIndex onward, and rewind ownership
    // prevents snapshot replacement until this trim has completed.
    const turn = this.state.turns[targetIndex]!;
    const planBefore = turn.planBefore!;
    const todosBefore = turn.todosBefore!;
    const removedIds = new Set(this.state.turns.slice(targetIndex).map((item) => item.id));
    const planFiles = new Map(plan.files.map((file) => [file.path, file]));
    const changes: FileChange[] = [];
    for (const change of this.state.changes) {
      if (change.path === 'patch' || change.path === 'turn.diff') continue;
      let relative: string;
      try { relative = workspaceRelativePath(this.state.selection.cwd, change.path); }
      catch { changes.push(change); continue; }
      const restored = planFiles.get(relative);
      if (!restored) { changes.push(change); continue; }
      if (change.previousText === undefined) throw new Error(`The aggregate file history for ${relative} has no baseline.`);
      const current = { text: restored.beforeText, mode: restored.beforeMode };
      if (current.text === change.previousText && (change.previousMode === undefined || current.mode === change.previousMode)) continue;
      const kind: FileChange['kind'] = current.text === null ? 'delete' : change.previousText === null ? 'add' : 'update';
      const before = change.previousText ?? '';
      const after = current.text ?? '';
      changes.push({ ...change, kind, mode: current.mode, additions: undefined, deletions: undefined,
        ...(before === after ? {} : { diff: undefined }) });
      const row = changes.at(-1)!;
      const counts = lineChangeCounts(before, after);
      if (counts) { row.additions = counts.additions; row.deletions = counts.deletions; }
      else { delete row.additions; delete row.deletions; }
    }
    const prefixTurns = this.state.turns.slice(0, targetIndex);
    const usage = prefixTurns.reduce<import('./types.js').UsageStats | null>((sum, item) => item.usage ? addUsage(sum, item.usage) : sum, null);
    const allowedUsageKeys = new Set(prefixTurns.map((item) => item.id));
    const usageSamples = Object.fromEntries(Object.entries(this.state.usageSamples ?? {}).filter(([key]) => {
      const match = /^(?:run|baseline):([^:]+)(?::|$)/.exec(key);
      return Boolean(match && allowedUsageKeys.has(match[1]!));
    }));
    const subagents = this.state.subagents.filter((child) => child.parentTurnId && !removedIds.has(child.parentTurnId));
    return {
      messages: this.state.messages.slice(0, userIndex),
      turns: prefixTurns,
      changes,
      todos: structuredClone(todosBefore),
      plan: structuredClone(planBefore),
      usage,
      usageSamples,
      subagents,
      terminals: structuredClone(terminals),
      terminalError: undefined,
      queue: [],
      pendingPermission: null,
      pendingPlan: null,
      pendingQuestion: null,
    };
  }

  setTerminals(terminals: TerminalRecord[]): void {
    if (this.rewinding && !this.rewindSending) return;
    this.state.terminals = terminals;
    this.publish();
  }

  hasLiveTerminals(): boolean {
    return this.state.terminals.some((item) => !item.status || !/complete|exit|done|terminat|kill|dead|fail|cancel|abort|succeed/i.test(item.status));
  }
  hasLiveChildren(): boolean {
    return this.state.subagents.some((item) => item.status === 'running' || item.status === 'unknown');
  }
  interactionTokens(): { permission: string | null; plan: string | null; question: string | null } {
    return {
      permission: this.permissionWait?.token ?? null,
      plan: this.planWait?.token ?? null,
      question: this.questionWait?.token ?? null,
    };
  }

  private publish(): void { this.changed(this.snapshot()); }

  setAutoApprove(enabled: boolean): void {
    this.state.autoApprove = enabled;
    this.publish();
  }

  setStatus(status: ConnectionStatus): void {
    if (this.state.status === status) return;
    this.state.status = status;
    this.publish();
  }

  rememberSession(summary: SessionSummary): void {
    this.state.sessions = upsertSession(this.state.sessions, summary);
    this.publish();
  }

  replaceSessions(sessions: SessionSummary[]): void {
    this.state.sessions = sessions;
    this.publish();
  }

  notify(text: string): void {
    this.state.messages.push({ id: randomUUID(), role: 'status', text, at: Date.now() });
    this.publish();
  }

  async select(selection: Selection): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    if (this.modelChangeDone) await this.modelChangeDone;
    while (this.resetting) await this.resetting;
    const current = this.state.selection;
    if (current.provider === selection.provider && current.cwd === selection.cwd && current.model === selection.model
      && sameModelParams(current.modelParams, selection.modelParams)) return;
    if (this.active) throw new Error('実行が終わってからエージェントを切り替えてください。');
    await this.reset();
    this.state.selection = { ...selection };
    this.publish();
  }

  async updateSelection(selection: Selection): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    while (this.resetting) await this.resetting;
    if (this.active || this.changingModel) throw new Error('実行が終わってからモデルを選択してください。');
    const current = this.state.selection;
    if (current.provider === selection.provider && current.cwd === selection.cwd && current.model === selection.model
      && sameModelParams(current.modelParams, selection.modelParams)) return;
    if (current.provider !== selection.provider || current.cwd !== selection.cwd) {
      await this.select(selection);
      return;
    }
    const previous = { ...current, ...(current.modelParams ? { modelParams: current.modelParams.map((param) => ({ ...param })) } : {}) };
    this.changingModel = true;
    let release!: () => void;
    this.modelChangeDone = new Promise<void>((resolve) => { release = resolve; });
    try {
      await this.session?.setModel?.(selection);
      this.state.selection = cloneSelection(selection);
      this.publish();
    } catch (error) {
      this.state.selection = previous;
      this.publish();
      throw error;
    } finally {
      this.changingModel = false;
      this.modelChangeDone = undefined;
      release();
    }
  }

  async review(target: 'uncommitted' | 'base'): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    if (this.active || this.resetting || this.changingModel) throw new Error('エージェントは実行中です。');
    if (!this.session?.review) throw new Error('コードレビューAPIは Codex App Server でのみ使えます。差分を添付して依頼してください。');
    const turnId = randomUUID();
    const operation = { abort: new AbortController(), done: Promise.resolve() };
    this.active = operation;
    this.state.busy = true;
    this.state.status = 'running';
    this.state.messages.push({ id: turnId, role: 'user', text: target === 'base' ? '/review base' : '/review', at: Date.now() });
    this.publish();
    operation.done = (async () => {
      try {
        await this.session?.review?.(target, (update) => {
          if (operation.abort.signal.aborted || (update.meta?.type === 'usage' && !update.text)) {
            if (update.meta) this.absorb(update);
            return;
          }
          this.absorb(update);
          const message = this.stamp(turnId, update);
          const existing = this.state.messages.findIndex((item) => item.id === message.id);
          if (existing < 0) this.state.messages.push(message);
          else {
            // Review updates replace an earlier stamped update with the same request-local ID.
            const previous = this.state.messages[existing]!;
            this.state.messages[existing] = { ...message, at: previous.at };
          }
          this.publish();
        }, operation.abort.signal);
      } catch (error) {
        const cancelled = operation.abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        this.state.messages.push({ id: randomUUID(), role: cancelled ? 'status' : 'error', text: cancelled ? '停止しました。' : errorMessage(error) + ((error as { isRetryable?: boolean })?.isRetryable === false ? '\n設定の修正が必要です。変更しないまま再送しても同じエラーになります。Diagnoseで実行環境を確認してください。' : ''), at: Date.now() });
      } finally {
        if (this.active === operation) this.active = undefined;
        this.state.busy = Boolean(this.resetting);
        this.state.status = this.state.busy ? this.state.status : 'idle';
        this.publish();
      }
    })();
    await operation.done;
  }

  async applyMode(mode: AgentMode): Promise<boolean> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    if (this.active || this.resetting || this.changingModel) throw new Error('エージェントは実行中です。');
    if (!this.session?.setMode) {
      if (this.session) return false;
      this.modePreference = mode;
      return true;
    }
    this.changingModel = true;
    let release!: () => void;
    this.modelChangeDone = new Promise<void>((resolve) => { release = resolve; });
    try {
      await this.session.setMode(mode);
      this.modePreference = mode;
      return true;
    } finally {
      this.changingModel = false;
      this.modelChangeDone = undefined;
      release();
    }
  }

  setBuildModel(selection: Selection, label?: string): void {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    this.state.plan = setBuildSelection(this.state.plan, selection, label);
    this.publish();
  }

  restorePlan(plan: PlanState): void {
    if (this.rewinding) return;
    if (!plan.current || this.state.plan.current) return;
    // Only a persisted settled phase is safe to restore as actionable. A legacy
    // plan snapshot can outlive its conversation history, so an interrupted or
    // unknown execution must not turn back into a Build button after Reload.
    const phase = plan.phase === 'implemented' || plan.phase === 'ready' ? plan.phase : 'unknown';
    this.state.plan = { ...plan, phase, draft: undefined, current: { ...plan.current, restored: true } };
    this.state.todos = plan.current.todos;
    this.publish();
  }

  async hibernate(): Promise<void> {
    if (this.rewinding) return;
    if (this.active || this.resetting || this.changingModel || this.permissionWait || this.planWait || this.questionWait || this.hasLiveTerminals() || this.hasLiveChildren()) return;
    const session = this.session;
    if (!session) return;
    this.retainedId = session.sessionId || this.retainedId;
    this.session = undefined;
    this.unsubscribeBackground?.();
    this.unsubscribeBackground = undefined;
    await session.dispose();
  }

  async build(planId: string, revision: number, selection: Selection): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    if (this.state.plan.phase === 'building') return;
    if (this.active || this.resetting || this.changingModel) throw new Error('エージェントは実行中です。');
    if (selection.provider !== this.state.selection.provider || selection.cwd !== this.state.selection.cwd) throw new Error('同じ会話のモデルを選択してください。');
    const planBefore = structuredClone(this.state.plan);
    const todosBefore = structuredClone(this.state.todos);
    const next = requestBuild(this.state.plan, planId, revision, selection, this.sessionId());
    if ('error' in next) throw new Error(next.error);
    // requestBuild only succeeds when a ready plan is present.
    const plan = next.state.current!;
    this.state.plan = next.state;
    this.publish();
    try {
      await this.send(buildPrompt(plan), { displayText: `Build · ${selection.model || 'default'}` }, { intent: 'build', mode: 'agent', selection }, { plan: planBefore, todos: todosBefore });
    } catch (error) {
      if (this.state.plan.phase === 'building') {
        this.state.plan = finishBuild(this.state.plan, 'failed');
        this.publish();
      }
      throw error;
    }
  }

  enqueue(prompt: string, extras?: SendExtras): void {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    prompt = prompt.trim();
    if (!prompt && !extras?.images?.length) return;
    if (prompt.length > 100000) throw new Error('依頼は100,000文字以内で入力してください。');
    this.state.queue.push({ id: randomUUID(), text: prompt, ...(extras ? { extras } : {}) });
    this.autoDrain = true;
    this.publish();
    this.continueQueue();
  }

  sendQueued(id: string): Promise<void> {
    if (this.rewinding) return Promise.reject(new Error('巻き戻し処理中です。'));
    const index = this.state.queue.findIndex((item) => item.id === id);
    if (index < 0) return Promise.resolve();
    // The queue cannot change between findIndex and splice because this path is synchronous.
    const item = this.state.queue.splice(index, 1)[0]!;
    this.state.queue.unshift(item);
    this.autoDrain = true;
    this.publish();
    if (this.active && !this.active.abort.signal.aborted) {
      const done = this.active.done;
      this.active.abort.abort();
      this.addStatus('停止中…');
      return done.then(() => this.queueTail);
    }
    this.continueQueue();
    return this.queueTail;
  }

  async steerQueued(id: string): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    const item = this.state.queue.find((entry) => entry.id === id);
    if (!item) return;
    if (!this.session?.steer) throw new Error('このバックエンドは実行中の追加入力に対応していません。');
    const accepted = await this.session.steer(item.extras?.displayText || item.text);
    if (!accepted) throw new Error('このバックエンドは実行中の追加入力に対応していません。');
    this.removeQueued(id);
    this.addStatus('実行中のターンへ追加入力しました。');
  }

  removeQueued(id: string): void {
    if (this.rewinding) return;
    this.state.queue = this.state.queue.filter((item) => item.id !== id);
    this.publish();
  }

  async send(prompt: string, extras?: SendExtras, turn?: TurnOptions, historyBefore?: { plan: PlanState; todos: ChatState['todos'] }): Promise<void> {
    prompt = prompt.trim();
    if (!prompt && !extras?.images?.length) return;
    if (this.active || this.resetting || this.changingModel || this.rewinding && !this.rewindSending) throw new Error('エージェントは実行中です。');
    const selection = turn?.selection ?? this.state.selection;
    const mode = turn?.mode ?? this.modePreference;
    const intent = turn?.intent ?? inferIntent(mode, this.state.plan);
    const turnOptions: TurnOptions = { intent, mode, selection };
    const planBefore = structuredClone(historyBefore?.plan ?? this.state.plan);
    const todosBefore = structuredClone(historyBefore?.todos ?? this.state.todos);
    if (intent === 'plan' || intent === 'revise') this.state.plan = beginPlanning(this.state.plan);
    const turnId = randomUUID();
    turnOptions.executionId = turnId;
    const record: TurnRecord = {
      id: turnId, startedAt: Date.now(), status: 'running', waitMs: 0, mode, model: selection.model, intent,
      planBefore, todosBefore,
      ...(extras?.images?.length ? { imageCount: extras.images.length } : {}),
    };
    this.state.turns = [...this.state.turns, record];
    this.currentTurn = turnId;
    this.fileObservations.set(turnId, { rawPaths: [] });
    this.turnWait = 0;
    const operation = { abort: new AbortController(), done: Promise.resolve() };
    this.active = operation;
    this.state.busy = true;
    this.state.status = 'running';
    const attachments = extras?.attachments?.map((item) => item.slice(0, 200)).slice(0, 20).filter(Boolean);
    const retry = extras?.retryOf ? this.state.messages.find((m) => m.id === extras.retryOf && m.role === 'user' && m.text === (extras?.displayText ?? prompt).trim()) : undefined;
    if (retry) record.userMessageId = retry.id;
    this.retryInputs.set(turnId, { prompt, extras });
    if (!retry) this.state.messages.push({
      id: turnId, role: 'user', text: (extras?.displayText ?? prompt).trim(), at: Date.now(),
      ...(attachments?.length ? { attachments } : {}),
    });
    this.publish();
    operation.done = (async () => {
      const signal = operation.abort.signal;
      try {
        await this.openAgent(signal);
        signal.throwIfAborted();
        if (intent === 'build') {
          await this.session?.setModel?.(selection);
          this.state.selection = cloneSelection(selection);
          signal.throwIfAborted();
          this.modePreference = 'agent';
          this.publish();
        }
        await this.session?.run(prompt, signal, (update) => {
          if (operation.abort.signal.aborted) return;
          this.receiveUpdate(turnId, update);
        }, extras, turnOptions);
        if (signal.aborted) this.addStatus('停止しました。');
        this.finishTurn(turnId, signal.aborted ? 'cancelled' : 'completed', intent);
      } catch (error) {
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        const text = cancelled ? '停止しました。' : errorMessage(error);
        const existingError = !cancelled ? this.state.messages.find((message) => message.role === 'error' && message.turnId === (record.userMessageId ?? turnId) && (message.text === text || message.text.endsWith(text))) : undefined;
        const failure = !cancelled ? { kind: error instanceof Error ? error.name : 'Error', retryable: (error as { isRetryable?: boolean })?.isRetryable !== false, operation: (error as { operation?: string })?.operation } : undefined;
        if (existingError) existingError.failure = failure;
        else this.state.messages.push({
          id: randomUUID(), role: cancelled ? 'status' : 'error', turnId: record.userMessageId ?? turnId,
          text: text + (failure?.retryable === false ? '\n設定の修正が必要です。変更しないまま再送しても同じエラーになります。Diagnoseで実行環境を確認してください。' : ''),
          at: Date.now(), ...(failure ? { failure } : {}),
        });
        if ((error as { executionUncertain?: boolean }).executionUncertain) {
          record.status = 'unknown';
          if (intent !== 'chat') this.state.plan.phase = 'unknown';
          this.currentTurn = undefined;
        } else this.finishTurn(turnId, cancelled ? 'cancelled' : 'failed', intent);
        if (!cancelled) {
          this.state.status = 'error';
          this.autoDrain = false;
        }
      } finally {
        await this.captureTurnFileCheckpoint(turnId);
        if (this.session?.closed) {
          this.retainedId = this.session.sessionId || this.retainedId;
          const dead = this.session;
          this.session = undefined;
          this.unsubscribeBackground?.();
          this.unsubscribeBackground = undefined;
          await dead.dispose();
        } else if (this.session?.sessionId) this.retainedId = this.session.sessionId;
        if (this.state.selection.cwd && this.state.changes.length) {
          this.state.changes = await refreshChangeStats(this.state.selection.cwd, this.state.changes).catch(() => this.state.changes);
        }
        if (this.active === operation) this.active = undefined;
        if (this.autoDrain && !this.resetting) this.continueQueue();
        this.state.busy = Boolean(this.active || this.resetting);
        if (!this.state.busy && !this.permissionWait && !this.planWait && !this.questionWait && this.state.status !== 'error') {
          this.state.status = 'idle';
        }
        this.publish();
      }
    })();
    await operation.done;
  }

  private continueQueue(): void {
    if (!this.autoDrain || this.active || this.resetting) return;
    const next = this.state.queue.shift();
    if (!next) return;
    this.queueTail = this.send(next.text, next.extras).catch(() => undefined);
  }

  stop(): void {
    this.autoDrain = false;
    this.settleInteractions();
    this.state.subagentWaiting = undefined;
    if (this.active && !this.active.abort.signal.aborted) {
      this.active.abort.abort();
      this.state.status = 'cancelling';
      this.addStatus('停止中…');
    }
  }

  private async openAgent(signal?: AbortSignal): Promise<void> {
    if (this.session?.closed) {
      this.retainedId = this.session.sessionId || this.retainedId;
      const dead = this.session;
      this.session = undefined;
      this.unsubscribeBackground?.();
      this.unsubscribeBackground = undefined;
      await dead.dispose();
    }
    if (!this.session) {
      this.workspaceRealPath = await realpath(this.state.selection.cwd).catch(() => path.resolve(this.state.selection.cwd));
      const session = await this.factory({ ...this.state.selection }, { signal, resumeId: this.retainedId });
      this.session = session;
      this.unsubscribeBackground = this.bindSession(session);
    }
    if (this.session.sessionId) this.retainedId = this.session.sessionId;
  }

  private bindSession(session: AgentSession): (() => void) | undefined {
    return session.subscribeBackgroundUpdates?.((update) => {
      if (this.session !== session || this.resetting || this.rewinding && !this.rewindSending) return;
      const origin = (update.backendTurnId ? this.state.turns.find((turn) => turn.backendTurnId === update.backendTurnId)?.id : undefined) ?? this.updateTurns.get(update.id) ?? this.currentTurn ?? this.state.turns.at(-1)?.id ?? session.sessionId ?? 'background';
      this.receiveUpdate(origin, update);
    });
  }

  private addStatus(text: string): void {
    this.state.messages.push({ id: randomUUID(), role: 'status', text, at: Date.now(), ...(this.currentTurn ? { turnId: this.state.turns.find((turn) => turn.id === this.currentTurn)?.userMessageId ?? this.currentTurn } : {}) });
    this.publish();
  }

  private stamp(turnId: string, update: AgentUpdate): ChatMessage {
    const text = update.subagentId
      ? `${redactSecrets(update.text).slice(0, 12000)}${update.text.length > 12000 ? '\n[Earlier output omitted]' : ''}`
      : update.text;
    return {
      ...update,
      ...(update.subagentId && update.tool ? { tool: { ...update.tool, name: redactSecrets(update.tool.name).slice(0, 120), ...(update.tool.target ? { target: redactSecrets(update.tool.target).slice(0, 2000) } : {}) } } : {}),
      id: update.subagentId ? `${turnId}:child:${update.subagentId}:${update.id}` : `${turnId}:${update.id}`,
      text,
      turnId: this.state.turns.find((turn) => turn.id === turnId)?.userMessageId ?? turnId,
      backendId: update.backendId ?? update.id,
      ...(update.backendTurnId ? { backendTurnId: update.backendTurnId } : {}),
      meta: lightMeta(update.meta),
      ...(update.final ? { final: true } : {}),
      at: Date.now(),
    };
  }

  private sanitizeSubagentMessage(message: ChatMessage): ChatMessage {
    if (!message.subagentId) return message;
    const redacted = redactSecrets(message.text);
    const text = redacted.length > 12000 ? `${redacted.slice(0, 12000)}\n[Earlier output omitted]` : redacted;
    if (redacted.length > 12000) {
      const child = this.state.subagents.find((item) => item.id === message.subagentId);
      if (child) child.historyOmitted = true;
    }
    let meta = lightMeta(message.meta);
    if (meta) {
      try {
        const encoded = JSON.stringify(meta);
        if (encoded.length > 30000) {
          meta = undefined;
          const child = this.state.subagents.find((item) => item.id === message.subagentId);
          if (child) child.historyOmitted = true;
        } else {
          const safe = JSON.stringify(meta, (_key, value: unknown) => typeof value === 'string' ? redactSecrets(value) : value);
          meta = JSON.parse(safe) as ChatMessage['meta'];
        }
      } catch { meta = undefined; }
    }
    return {
      ...message,
      text,
      ...(message.tool ? { tool: { ...message.tool, name: redactSecrets(message.tool.name).slice(0, 120), ...(message.tool.target ? { target: redactSecrets(message.tool.target).slice(0, 2000) } : {}) } } : {}),
      ...(meta ? { meta } : { meta: undefined }),
    };
  }

  private trimSubagentHistory(subagentId: string): void {
    const rows = this.state.messages.filter((message) => message.subagentId === subagentId);
    const size = (message: ChatMessage) => { try { return JSON.stringify(message).length; } catch { return message.text.length; } };
    let total = rows.reduce((sum, message) => sum + size(message), 0);
    let omitted = false;
    while (rows.length > 80 || total > 160000) {
      const old = rows.shift()!;
      total -= size(old);
      const index = this.state.messages.findIndex((message) => message.id === old.id);
      if (index >= 0) this.state.messages.splice(index, 1);
      omitted = true;
    }
    if (omitted) {
      const child = this.state.subagents.find((item) => item.id === subagentId);
      if (child) child.historyOmitted = true;
    }
    this.trimTotalSubagentHistory();
  }

  private trimTotalSubagentHistory(): void {
    const rows = this.state.messages.filter((message) => message.subagentId);
    const size = (message: ChatMessage) => { try { return JSON.stringify(message).length; } catch { return message.text.length; } };
    let total = rows.reduce((sum, message) => sum + size(message), 0);
    while (total > 1000000) {
      const old = rows.shift()!;
      total -= size(old);
      const index = this.state.messages.findIndex((message) => message.id === old.id);
      if (index >= 0) this.state.messages.splice(index, 1);
      const child = this.state.subagents.find((item) => item.id === old.subagentId);
      if (child) child.historyOmitted = true;
    }
  }

  private receiveUpdate(turnId: string, update: AgentUpdate): void {
    const childTurnId = update.subagentId
      ? this.state.subagents.find((child) => child.id === update.subagentId)?.parentTurnId : undefined;
    const backendTurn = update.backendTurnId
      ? this.state.turns.find((turn) => turn.backendTurnId === update.backendTurnId)?.id : undefined;
    const origin = childTurnId ?? backendTurn ?? this.updateTurns.get(update.id) ?? turnId;
    // Plan and To-do notifications mutate the currently actionable plan. A
    // delayed notification from a completed turn must not become a newer
    // revision draft or overwrite progress while another turn is active.
    if ((update.meta?.type === 'plan' || update.meta?.type === 'todo') && origin !== this.currentTurn) return;
    if (update.meta?.type === 'subagentWait' && update.meta.subagentWait) {
      if (update.meta.subagentWait.waiting) {
        if (this.active && origin === this.currentTurn) {
          this.state.subagentWaiting = { parentTurnId: origin, startedAt: update.meta.subagentWait.startedAt ?? Date.now() };
          this.updateTurns.set(update.id, origin);
        }
      } else if (this.state.subagentWaiting?.parentTurnId === origin) {
        this.state.subagentWaiting = undefined;
      }
      this.publish();
      return;
    }
    if (update.meta?.type === 'files' && update.meta.files) {
      const observation = this.fileObservations.get(origin);
      if (observation) {
        if (update.id.startsWith('workspace-changes:')) observation.finalFiles = structuredClone(update.meta.files);
        else for (const file of update.meta.files) if (file.path !== 'patch' && file.path !== 'turn.diff') observation.rawPaths.push(file.path);
      }
    }
    if (update.meta?.type === 'subagent' || update.meta?.type === 'terminals' || update.tool?.kind === 'shell') this.updateTurns.set(update.id, origin);
    const turn = this.state.turns.find((item) => item.id === origin);
    if (turn && update.backendTurnId) turn.backendTurnId = update.backendTurnId;
    this.absorb(update, origin);
    if (update.subagentId) {
      const child = this.state.subagents.find((item) => item.id === update.subagentId);
      const progress = update.tool
        ? `${update.tool.name}${update.tool.target ? ` · ${update.tool.target}` : ''}`
        : update.text.trim().split('\n')[0];
      if (child && progress) child.progress = redactSecrets(progress).slice(0, 180);
    }
    if (update.meta?.type !== 'terminals' && !(update.meta?.type === 'usage' && !update.text)) {
      const message = this.stamp(origin, update);
      let index = this.state.messages.findIndex((item) => item.id === message.id);
      if (index < 0 && message.role === 'error') {
        index = this.state.messages.findIndex((item) => item.role === 'error' && item.turnId === message.turnId
          && (item.text === message.text || item.text.endsWith(message.text) || message.text.endsWith(item.text)));
      }
      if (index < 0 && update.meta?.subagent) index = this.state.messages.findIndex((item) => item.meta?.subagent?.id === update.meta?.subagent?.id);
      if (index < 0) this.state.messages.push(message);
      else {
        const previous = this.state.messages[index]!;
        this.state.messages[index] = {
          ...message,
          id: previous.id,
          ...(message.role === 'error' ? { text: previous.text } : {}),
          at: previous.at ?? message.at,
        };
      }
      if (update.subagentId) this.trimSubagentHistory(update.subagentId);

    }
    this.publish();
  }

  private absorb(update: Pick<AgentUpdate, 'id' | 'meta'>, turnId = this.currentTurn): void {
    if (update.meta?.type === 'usage' && update.meta.usage) {
      const next = update.meta.usage;
      const samples = this.state.usageSamples ??= {};
      const turn = this.state.turns.find((item) => item.id === turnId);
      if (next.scope === 'request' && samples[`session:${next.source ?? 'backend'}`]) return;
      if (next.scope === 'session') {
        const key = `session:${next.source ?? 'backend'}`;
        const previous = samples[key];
        const baselineKey = `baseline:${turnId}`;
        if (!samples[baselineKey] && (previous || (!this.restored && !this.usageBaselineUnknown && this.state.turns.length === 1))) samples[baselineKey] = previous ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
        if (turn && samples[baselineKey]) turn.usage = usageDifference(next, samples[baselineKey]);
        samples[key] = next;
        this.state.usage = next;
      } else {
        const key = `run:${turnId}:${next.sampleId ?? update.id}`;
        samples[key] = next;
        const own = Object.entries(samples).filter(([id]) => id.startsWith(`run:${turnId}:`)).map(([, value]) => value);
        // The current sample was inserted above, so this reduction always has at least one value.
        if (turn) turn.usage = own.reduce<import('./types.js').UsageStats | null>((sum, value) => addUsage(sum, value), null)!;
        this.state.usage = Object.entries(samples).filter(([id]) => id.startsWith('run:')).reduce<import('./types.js').UsageStats | null>((sum, [, value]) => addUsage(sum, value), null);
        if (this.state.usage) this.state.usage.scope = 'session';
      }
    }
    const workspacePath = (name: string): string => {
      const resolved = path.resolve(this.state.selection.cwd, name);
      // absorb() is reached only for events from an openAgent() session.
      const relative = path.relative(this.workspaceRealPath!, resolved);
      return !relative.startsWith('..') && !path.isAbsolute(relative) ? path.resolve(this.state.selection.cwd, relative) : resolved;
    };
    if (update.meta?.type === 'files' && update.meta.files) this.state.changes = mergeFileChanges(this.state.changes, update.meta.files.map((file) => ({
      ...file,
      path: file.path === 'patch' || file.path === 'turn.diff' ? file.path : workspacePath(file.path),
      ...(file.oldPath ? { oldPath: workspacePath(file.oldPath) } : {}),
    })));
    if (update.meta?.type === 'todo' && update.meta.todos) {
      this.state.todos = update.meta.todos;
      this.state.plan = applyPlanTodos(this.state.plan, update.meta.todos);
    }
    if (update.meta?.type === 'plan' && update.meta.plan?.markdown) this.state.plan = stageDraft(this.state.plan, update.meta.plan);
    if (update.meta?.type === 'subagent' && update.meta.subagent) {
      const previous = this.state.subagents.find((item) => item.id === update.meta?.subagent?.id);
      const safeSubagent = lightMeta(update.meta)!.subagent!;
      const suppliedParent = safeSubagent.parentTurnId;
      const mappedParent = suppliedParent ? this.state.turns.find((turn) => turn.backendTurnId === suppliedParent)?.id : undefined;
      const parentTurnId = previous?.parentTurnId ?? this.updateTurns.get(update.id) ?? mappedParent
        ?? (suppliedParent && this.state.turns.some((turn) => turn.id === suppliedParent) ? suppliedParent : undefined)
        ?? this.currentTurn;
      const incoming = { ...safeSubagent, ...(parentTurnId ? { parentTurnId } : {}) };
      const index = this.state.subagents.findIndex((item) => item.id === incoming.id);
      if (index < 0) this.state.subagents.push(incoming);
      else this.state.subagents[index] = { ...this.state.subagents[index], ...incoming };
    }
    if (update.meta?.type === 'terminals' && update.meta.terminals) {
      const terminals = update.meta.terminals;
      if (this.restored) {
        const current = new Map(terminals.map((terminal) => [terminal.processId, terminal]));
        // A successful empty list after reload cannot prove that a saved running process exited.
        // Keep absent saved records as Unknown until the backend reports that exact process again.
        for (const terminal of this.state.terminals) {
          if (terminal.status === 'unknown' && !current.has(terminal.processId)) current.set(terminal.processId, terminal);
        }
        this.state.terminals = [...current.values()];
      } else this.state.terminals = terminals;
      this.state.terminalError = update.meta.terminalError;
    }
  }

  private finishTurn(turnId: string, status: TurnRecord['status'], intent: TurnOptions['intent']): void {
    if (this.state.subagentWaiting?.parentTurnId === turnId) this.state.subagentWaiting = undefined;
    if (this.waitStarted !== undefined) {
      this.turnWait += Date.now() - this.waitStarted;
      this.waitStarted = undefined;
    }
    const turn = this.state.turns.find((item) => item.id === turnId);
    if (turn) {
      turn.status = status;
      turn.endedAt = Date.now();
      turn.waitMs = this.turnWait;
    }
    this.markFinal(turnId);
    if (turn) turn.finalMessageId = this.state.messages.find((message) => message.final && message.id.startsWith(`${turnId}:`))?.id;
    if (intent === 'build') this.state.plan = finishBuild(this.state.plan, status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed');
    else if (intent === 'plan' || intent === 'revise') {
      const draft = this.state.plan.draft?.markdown;
      this.state.plan = status === 'completed' && draft
        ? commitDraft(this.state.plan, this.state.selection, this.sessionId())
        : planningFailed(this.state.plan, status === 'completed' ? '計画は作成されませんでした。' : undefined);
    }
    if (this.currentTurn === turnId) this.currentTurn = undefined;
  }

  private markFinal(turnId: string): void {
    const messages = this.state.messages.filter((message) => message.role === 'assistant' && message.id.startsWith(`${turnId}:`));
    if (messages.some((message) => message.final)) return;
    const last = messages.at(-1);
    if (last) last.final = true;
  }

  private armWait(): void {
    if (this.waitStarted === undefined) this.waitStarted = Date.now();
  }

  private releaseWait(): void {
    if (this.permissionWait || this.planWait || this.questionWait || this.waitStarted === undefined) return;
    this.turnWait += Date.now() - this.waitStarted;
    this.waitStarted = undefined;
    const turn = this.state.turns.find((item) => item.id === this.currentTurn);
    if (turn) turn.waitMs = this.turnWait;
  }

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.state.autoApprove) return Promise.resolve('allow-once');
    if (this.allowSession.some((rule) => rule.kind === request.kind && rule.title === request.title && rule.detail === request.detail)) {
      return Promise.resolve('allow-once');
    }
    return new Promise((resolve) => {
      this.armWait();
      const wait = { request, token: randomUUID(), resolve };
      if (this.permissionWait) { this.permissionQueue.push(wait); return; }
      this.permissionWait = wait;
      this.state.pendingPermission = request;
      this.state.status = 'waiting_approval';
      this.publish();
    });
  }

  resolvePermission(id: string, decision: PermissionDecision, token?: string): void {
    const pending = this.permissionWait;
    if (!pending || pending.request.id !== id || (token !== undefined && token !== pending.token)) return;
    if (decision === 'allow-session') {
      this.allowSession.push({ kind: pending.request.kind, title: pending.request.title, detail: pending.request.detail });
    }
    this.permissionWait = this.permissionQueue.shift() ?? null;
    this.state.pendingPermission = this.permissionWait?.request ?? null;
    if (!this.permissionWait && this.state.status === 'waiting_approval') this.state.status = this.active ? 'running' : 'idle';
    pending.resolve(decision === 'allow-session' ? 'allow-session' : decision);
    this.releaseWait();
    this.publish();
  }

  requestPlan(request: PlanRequest): Promise<'accepted' | 'rejected'> {
    return new Promise((resolve) => {
      this.armWait();
      this.planWait = { request, token: randomUUID(), resolve };
      this.state.pendingPlan = request;
      this.state.todos = request.todos;
      this.state.status = 'waiting_approval';
      this.publish();
    });
  }

  resolvePlan(id: string, decision: 'accepted' | 'rejected', token?: string): void {
    const pending = this.planWait;
    if (!pending || pending.request.id !== id || (token !== undefined && token !== pending.token)) return;
    this.planWait = null;
    this.state.pendingPlan = null;
    if (this.state.status === 'waiting_approval') this.state.status = this.active ? 'running' : 'idle';
    pending.resolve(decision);
    this.releaseWait();
    this.publish();
  }

  requestAnswers(request: QuestionRequest): Promise<Record<string, string[]>> {
    return new Promise((resolve) => {
      this.armWait();
      this.questionWait = { request, token: randomUUID(), resolve };
      this.state.pendingQuestion = request;
      this.state.status = 'waiting_approval';
      this.publish();
    });
  }

  resolveAnswers(id: string, answers: Record<string, string[]>, token?: string): void {
    const pending = this.questionWait;
    if (!pending || pending.request.id !== id || (token !== undefined && token !== pending.token)) return;
    this.questionWait = null;
    this.state.pendingQuestion = null;
    if (this.state.status === 'waiting_approval') this.state.status = this.active ? 'running' : 'idle';
    pending.resolve(answers);
    this.releaseWait();
    this.publish();
  }

  private settleInteractions(): void {
    const permission = this.permissionWait;
    this.permissionWait = null;
    this.state.pendingPermission = null;
    permission?.resolve('deny');
    for (const wait of this.permissionQueue.splice(0)) wait.resolve('deny');
    const plan = this.planWait;
    this.planWait = null;
    this.state.pendingPlan = null;
    plan?.resolve('rejected');
    const question = this.questionWait;
    this.questionWait = null;
    this.state.pendingQuestion = null;
    question?.resolve({});
  }

  async openSession(): Promise<void> {
    if (this.rewinding) throw new Error('巻き戻し処理中です。');
    while (this.resetting) await this.resetting;
    if (this.active || this.changingModel) throw new Error('エージェントは実行中です。');
    const operation = { abort: new AbortController(), done: Promise.resolve() };
    this.active = operation;
    this.state.busy = true;
    this.state.status = 'restoring';
    this.publish();
    operation.done = this.restoreSessionContents(operation.abort.signal).finally(() => {
      if (this.active === operation) this.active = undefined;
      if (this.autoDrain && !this.resetting) this.continueQueue();
      this.state.busy = Boolean(this.active || this.resetting);
      this.publish();
    });
    await operation.done;
  }

  private async restoreSessionContents(signal: AbortSignal): Promise<void> {
    try {
      await this.openAgent(signal);
      signal.throwIfAborted();
      // openAgent either leaves an assigned session or throws before returning.
      const session = this.session!;
      if (session.sessionId) this.retainedId = session.sessionId;
      const interrupted = [...this.state.turns].reverse().find((turn) => turn.status === 'unknown');
      if (interrupted && session.recoverRun) {
        this.currentTurn = interrupted.id;
        this.turnWait = interrupted.waitMs;
        let attached = false;
        try {
          const recovered = await session.recoverRun(interrupted.id, signal, (update) => {
            this.receiveUpdate(interrupted.id, update);
          }, () => {
            attached = true;
            interrupted.status = 'running';
            this.state.status = 'running';
            if (interrupted.intent === 'plan' || interrupted.intent === 'revise') {
              const savedDraft = this.state.plan.draft;
              this.state.plan = beginPlanning(interrupted.planBefore ?? this.state.plan);
              if (savedDraft) this.state.plan.draft = savedDraft;
            } else if (interrupted.intent === 'build') this.state.plan.phase = 'building';
            this.publish();
          });
          if (recovered) this.finishTurn(interrupted.id, 'completed', interrupted.intent);
        } catch (error) {
          // Losing the owner is not completion and must keep Build disabled.
          if (attached && (error as { executionStatus?: string }).executionStatus) {
            this.finishTurn(interrupted.id, (error as { executionStatus?: string }).executionStatus === 'cancelled' ? 'cancelled' : 'failed', interrupted.intent);
          } else {
            interrupted.status = 'unknown';
            if (interrupted.intent !== 'chat') this.state.plan.phase = 'unknown';
          }
          throw error;
        } finally { this.currentTurn = undefined; }
      }
      if (session.loadTranscript && !this.replayed) {
        const replay: ChatMessage[] = [];
        await session.loadTranscript((message) => replay.push(message));
        signal.throwIfAborted();
        if (replay.length) {
          const knownTurns = new Set(this.state.turns.map((turn) => turn.backendTurnId).filter(Boolean));
          const byId = new Map(this.state.messages.map((m) => [m.id, m]));
          for (const message of replay) {
            if (message.backendTurnId && knownTurns.has(message.backendTurnId)) {
              const turn = this.state.turns.find((item) => item.backendTurnId === message.backendTurnId)!;
              if (message.role === 'user' || !message.backendId) continue;
              const id = message.subagentId
                ? `${turn.id}:child:${message.subagentId}:${message.backendId}`
                : `${turn.id}:${message.backendId}`;
              if (message.role === 'assistant' && message.final && !message.subagentId && turn.status === 'unknown') {
                // A final from this exact backend turn resolves the unknown status,
                // but transcript replay time is not the backend's completion time.
                turn.status = 'completed';
                delete turn.endedAt;
                turn.finalMessageId = id;
              }
              const local = byId.get(id);
              if (local) {
                // A terminal backend snapshot can complete a saved prefix without discarding local metadata.
                if (message.role === 'assistant' && message.final && !message.subagentId) {
                  byId.set(id, { ...local, text: message.text, final: true });
                } else if (turn.status === 'completed' && message.text.startsWith(local.text) && message.text.length > local.text.length) {
                  byId.set(id, { ...local, text: message.text });
                }
              } else {
            const recovered = this.sanitizeSubagentMessage({ ...message, id, turnId: turn.userMessageId ?? turn.id });
                this.absorb(recovered); byId.set(id, recovered);
              }
              continue;
            }
            if (this.restored && !message.backendTurnId) continue;
            this.absorb(message);
            byId.set(message.id, message);
          }
          this.state.messages = [...byId.values()];
        } else if (!this.state.messages.length) this.addStatus('セッションは再開しましたが、表示履歴は未取得です。保存開始前の会話や非対応バックエンドの可能性があります。');
        this.replayed = true;
      } else if (!this.state.messages.length) this.addStatus('セッションを再開しました。表示履歴は未取得です。');
      await session.listBackgroundTerminals?.().catch(() => undefined);
      this.state.status = 'idle';
    } catch (error) {
      this.state.status = signal.aborted ? 'idle' : 'error';
      if (!signal.aborted) {
        this.autoDrain = false;
        this.state.messages.push({ id: randomUUID(), role: 'error', text: errorMessage(error), at: Date.now() });
      }
    }
    this.publish();
  }

  reset(): Promise<void> {
    if (this.rewinding) return Promise.reject(new Error('巻き戻し処理中です。'));
    if (this.modelChangeDone) return this.modelChangeDone.then(() => this.reset());
    if (this.resetting) return this.resetting;
    this.retainedId = undefined;
    this.autoDrain = false;
    this.state.queue = [];
    this.settleInteractions();
    this.stop();
    this.state.busy = true;
    this.publish();
    this.resetting = (async () => {
      try {
        await this.active?.done;
        // The finishing turn may retain its session ID after reset first clears it.
        this.retainedId = undefined;
        const session = this.session;
        this.session = undefined;
        this.unsubscribeBackground?.();
        this.unsubscribeBackground = undefined;
        this.updateTurns.clear();
        this.replayed = false;
        this.allowSession.length = 0;
        await session?.dispose();
        this.state.messages = [];
        this.state.changes = [];
        this.state.todos = [];
        this.state.usage = null;
        this.state.usageSamples = {};
        this.restored = false;
        this.usageBaselineUnknown = false;
        this.retryInputs.clear();
        this.state.pendingPermission = null;
        this.state.pendingPlan = null;
        this.state.pendingQuestion = null;
        this.state.plan = emptyPlanState();
        this.state.turns = [];
        this.state.subagents = [];
        this.state.terminals = [];
        this.state.terminalError = undefined;
        this.state.operationLabel = undefined;
        this.currentTurn = undefined;
        this.state.status = 'idle';
      } finally {
        this.resetting = undefined;
        this.state.busy = false;
        this.publish();
      }
    })();
    return this.resetting;
  }

  async dispose(): Promise<void> {
    if (this.session?.detach) {
      this.autoDrain = false;
      this.unsubscribeBackground?.();
      await this.session.detach();
      return;
    }
    await this.reset();
  }
}
