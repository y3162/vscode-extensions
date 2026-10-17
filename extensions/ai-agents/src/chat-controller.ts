import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { refreshChangeStats } from './change-tracker.js';
import { sameModelParams } from './model-settings.js';
import { applyPlanTodos, beginPlanning, buildPrompt, cloneSelection, commitDraft, finishBuild, inferIntent, planningFailed, requestBuild, setBuildSelection, stageDraft } from './plan-state.js';
import { upsertSession } from './session-index.js';
import { usageDifference } from './usage.js';
import { addUsage, lightMeta } from './providers/details.js';
import { mergeFileChanges } from './change-review.js';
import {
  emptyPlanState, errorMessage, type AgentInteractions, type AgentMode, type AgentSession, type AgentUpdate, type ChatMessage,
  type ChatState, type ConnectionStatus, type PermissionDecision, type PermissionRequest, type PlanRequest, type PlanState,
  type QuestionRequest, type Selection, type SendExtras, type SessionSummary, type TerminalRecord, type TurnOptions, type TurnRecord,
} from './types.js';

type SessionFactory = (selection: Selection, context?: { signal?: AbortSignal; resumeId?: string }) => Promise<AgentSession>;

interface PermissionWait { request: PermissionRequest; token: string; resolve: (decision: PermissionDecision) => void }
interface PlanWait { request: PlanRequest; token: string; resolve: (decision: 'accepted' | 'rejected') => void }
interface QuestionWait { request: QuestionRequest; token: string; resolve: (answers: Record<string, string[]>) => void }

export class ChatController {
  private session?: AgentSession;
  private readonly retryInputs = new Map<string, { prompt: string; extras?: SendExtras }>();
  private restored = false;
  private unsubscribeBackground?: () => void;
  private readonly updateTurns = new Map<string, string>();
  private workspaceRealPath?: string;
  private active?: { abort: AbortController; done: Promise<void> };
  private resetting?: Promise<void>;
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
  prepareResume(id: string): void { this.retainedId = id; }
  planSnapshot(): PlanState { return structuredClone(this.state.plan); }

  restoreSnapshot(saved: ChatState, id?: string): void {
    const sessions = this.state.sessions;
    Object.assign(this.state, structuredClone(saved), { busy: false, queue: [], pendingPermission: null, pendingPlan: null, pendingQuestion: null, autoApprove: false, sessions });
    this.retainedId = id;
    this.restored = true;
    this.state.status = 'idle';
    for (const turn of this.state.turns) if (turn.status === 'running') { turn.status = 'cancelled'; turn.endedAt = Date.now(); }
    for (const child of this.state.subagents) if (child.status === 'running') child.status = 'unknown';
    for (const terminal of this.state.terminals) terminal.status = 'unknown';
    if (this.state.plan.phase === 'planning' || this.state.plan.phase === 'revising') this.state.plan = planningFailed(this.state.plan);
    if (this.state.plan.phase === 'building') this.state.plan = finishBuild(this.state.plan, 'cancelled');
    this.publish();
  }

  retryInput(id: string): { prompt: string; extras?: SendExtras } | undefined { return this.retryInputs.get(id); }

  setTerminals(terminals: TerminalRecord[]): void {
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
    while (this.resetting) await this.resetting;
    if (this.active) throw new Error('実行が終わってからモデルを選択してください。');
    const current = this.state.selection;
    if (current.provider === selection.provider && current.cwd === selection.cwd && current.model === selection.model
      && sameModelParams(current.modelParams, selection.modelParams)) return;
    if (current.provider !== selection.provider || current.cwd !== selection.cwd) {
      await this.select(selection);
      return;
    }
    const previous = { ...current, ...(current.modelParams ? { modelParams: current.modelParams.map((param) => ({ ...param })) } : {}) };
    this.state.selection = { ...selection };
    try {
      this.session?.setModel?.(selection);
      this.publish();
    } catch (error) {
      this.state.selection = previous;
      this.publish();
      throw error;
    }
  }

  async review(target: 'uncommitted' | 'base'): Promise<void> {
    if (this.active || this.resetting) throw new Error('エージェントは実行中です。');
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
          else this.state.messages[existing] = { ...message, at: this.state.messages[existing]?.at ?? message.at };
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
    this.modePreference = mode;
    if (!this.session?.setMode) return !this.session;
    await this.session.setMode(mode);
    return true;
  }

  setBuildModel(selection: Selection, label?: string): void {
    this.state.plan = setBuildSelection(this.state.plan, selection, label);
    this.publish();
  }

  restorePlan(plan: PlanState): void {
    if (!plan.current || this.state.plan.current) return;
    const phase = plan.phase === 'implemented' ? 'implemented' : 'ready';
    this.state.plan = { ...plan, phase, draft: undefined, current: { ...plan.current, restored: true } };
    this.state.todos = plan.current.todos;
    this.publish();
  }

  async hibernate(): Promise<void> {
    if (this.active || this.resetting || this.permissionWait || this.planWait || this.questionWait || this.hasLiveTerminals() || this.hasLiveChildren()) return;
    const session = this.session;
    if (!session) return;
    this.retainedId = session.sessionId || this.retainedId;
    this.session = undefined;
    this.unsubscribeBackground?.();
    this.unsubscribeBackground = undefined;
    await session.dispose();
  }

  async build(planId: string, revision: number, selection: Selection): Promise<void> {
    if (this.state.plan.phase === 'building') return;
    const next = requestBuild(this.state.plan, planId, revision, selection, this.sessionId());
    if ('error' in next) throw new Error(next.error);
    const plan = next.state.current;
    if (!plan) return;
    this.state.plan = next.state;
    this.state.selection = cloneSelection(selection);
    this.modePreference = 'agent';
    this.session?.setModel?.(selection);
    this.publish();
    try {
      await this.send(buildPrompt(plan), { displayText: `Build · ${selection.model || 'default'}` }, { intent: 'build', mode: 'agent', selection });
    } catch (error) {
      if (this.state.plan.phase === 'building') {
        this.state.plan = finishBuild(this.state.plan, 'failed');
        this.publish();
      }
      throw error;
    }
  }

  enqueue(prompt: string, extras?: SendExtras): void {
    prompt = prompt.trim();
    if (!prompt) return;
    if (prompt.length > 100000) throw new Error('依頼は100,000文字以内で入力してください。');
    this.state.queue.push({ id: randomUUID(), text: prompt, ...(extras ? { extras } : {}) });
    this.autoDrain = true;
    this.publish();
    this.continueQueue();
  }

  sendQueued(id: string): Promise<void> {
    const index = this.state.queue.findIndex((item) => item.id === id);
    if (index < 0) return Promise.resolve();
    const [item] = this.state.queue.splice(index, 1);
    if (!item) return Promise.resolve();
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
    const item = this.state.queue.find((entry) => entry.id === id);
    if (!item) return;
    if (!this.session?.steer) throw new Error('このバックエンドは実行中の追加入力に対応していません。');
    const accepted = await this.session.steer(item.extras?.displayText || item.text);
    if (!accepted) throw new Error('このバックエンドは実行中の追加入力に対応していません。');
    this.removeQueued(id);
    this.addStatus('実行中のターンへ追加入力しました。');
  }

  removeQueued(id: string): void {
    this.state.queue = this.state.queue.filter((item) => item.id !== id);
    this.publish();
  }

  async send(prompt: string, extras?: SendExtras, turn?: TurnOptions): Promise<void> {
    prompt = prompt.trim();
    if (!prompt) return;
    if (this.active || this.resetting) throw new Error('エージェントは実行中です。');
    const selection = turn?.selection ?? this.state.selection;
    const mode = turn?.mode ?? this.modePreference;
    const intent = turn?.intent ?? inferIntent(mode, this.state.plan);
    const turnOptions: TurnOptions = { intent, mode, selection };
    if (intent === 'plan' || intent === 'revise') this.state.plan = beginPlanning(this.state.plan);
    const turnId = randomUUID();
    const record: TurnRecord = { id: turnId, startedAt: Date.now(), status: 'running', waitMs: 0, mode, model: selection.model, intent };
    this.state.turns = [...this.state.turns, record];
    this.currentTurn = turnId;
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
        this.finishTurn(turnId, cancelled ? 'cancelled' : 'failed', intent);
        if (!cancelled) {
          this.state.status = 'error';
          this.autoDrain = false;
        }
      } finally {
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
      this.unsubscribeBackground = session.subscribeBackgroundUpdates?.((update) => {
        if (this.session !== session || this.resetting) return;
        const origin = this.updateTurns.get(update.id) ?? this.currentTurn ?? this.state.turns.at(-1)?.id ?? session.sessionId ?? 'background';
        this.receiveUpdate(origin, update);
      });
    }
    if (this.session.sessionId) this.retainedId = this.session.sessionId;
  }

  private addStatus(text: string): void {
    this.state.messages.push({ id: randomUUID(), role: 'status', text, at: Date.now(), ...(this.currentTurn ? { turnId: this.state.turns.find((turn) => turn.id === this.currentTurn)?.userMessageId ?? this.currentTurn } : {}) });
    this.publish();
  }

  private stamp(turnId: string, update: AgentUpdate): ChatMessage {
    return {
      ...update,
      id: `${turnId}:${update.id}`,
      text: update.text,
      turnId: this.state.turns.find((turn) => turn.id === turnId)?.userMessageId ?? turnId,
      backendId: update.backendId ?? update.id,
      meta: lightMeta(update.meta),
      ...(update.final ? { final: true } : {}),
      at: Date.now(),
    };
  }

  private receiveUpdate(turnId: string, update: AgentUpdate): void {
    const origin = this.updateTurns.get(update.id) ?? turnId;
    if (update.meta?.type === 'subagent' || update.meta?.type === 'terminals' || update.tool?.kind === 'shell') this.updateTurns.set(update.id, origin);
    const turn = this.state.turns.find((item) => item.id === origin);
    if (turn && update.backendTurnId) turn.backendTurnId = update.backendTurnId;
    this.absorb(update, origin);
    if (update.meta?.type !== 'terminals' && !(update.meta?.type === 'usage' && !update.text)) {
      const message = this.stamp(origin, update);
      let index = this.state.messages.findIndex((item) => item.id === message.id);
      if (index < 0 && update.meta?.subagent) index = this.state.messages.findIndex((item) => item.meta?.subagent?.id === update.meta?.subagent?.id);
      if (index < 0) this.state.messages.push(message);
      else this.state.messages[index] = { ...message, id: this.state.messages[index]!.id, at: this.state.messages[index]?.at ?? message.at };

    }
    this.publish();
  }

  private absorb(update: Pick<AgentUpdate, 'id' | 'meta'>, turnId = this.currentTurn): void {
    if (update.meta?.type === 'usage' && update.meta.usage) {
      const next = update.meta.usage;
      const samples = this.state.usageSamples ??= {};
      const turn = this.state.turns.find((item) => item.id === turnId);
      if (next.scope === 'request' && this.state.usage?.scope === 'session') return;
      if (next.scope === 'session') {
        const key = `session:${next.source ?? 'backend'}`;
        const previous = samples[key];
        const baselineKey = `baseline:${turnId}`;
        if (!samples[baselineKey] && (previous || !this.restored)) samples[baselineKey] = previous ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
        if (turn && samples[baselineKey]) turn.usage = usageDifference(next, samples[baselineKey]);
        samples[key] = next;
        this.state.usage = next;
      } else {
        const key = `run:${turnId}:${next.sampleId ?? update.id}`;
        samples[key] = next;
        const own = Object.entries(samples).filter(([id]) => id.startsWith(`run:${turnId}:`)).map(([, value]) => value);
        if (turn) turn.usage = own.reduce<import('./types.js').UsageStats | null>((sum, value) => addUsage(sum, value), null) ?? undefined;
        this.state.usage = Object.entries(samples).filter(([id]) => id.startsWith('run:')).reduce<import('./types.js').UsageStats | null>((sum, [, value]) => addUsage(sum, value), null);
        if (this.state.usage) this.state.usage.scope = 'session';
      }
    }
    const workspacePath = (name: string): string => {
      const resolved = path.resolve(this.state.selection.cwd, name);
      if (!this.workspaceRealPath) return resolved;
      const relative = path.relative(this.workspaceRealPath, resolved);
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
      const parentTurnId = previous?.parentTurnId ?? this.updateTurns.get(update.id) ?? this.currentTurn;
      const incoming = { ...update.meta.subagent, ...(parentTurnId ? { parentTurnId } : {}) };
      const index = this.state.subagents.findIndex((item) => item.id === incoming.id);
      if (index < 0) this.state.subagents.push(incoming);
      else this.state.subagents[index] = { ...this.state.subagents[index], ...incoming };
    }
    if (update.meta?.type === 'terminals' && update.meta.terminals) {
      this.state.terminals = update.meta.terminals;
      this.state.terminalError = update.meta.terminalError;
    }
  }

  private finishTurn(turnId: string, status: TurnRecord['status'], intent: TurnOptions['intent']): void {
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
    while (this.resetting) await this.resetting;
    if (this.active) throw new Error('実行が終わってからエージェントを切り替えてください。');
    this.state.status = 'restoring';
    this.publish();
    try {
      await this.openAgent();
      if (!this.session) throw new Error('セッションを再開できませんでした。');
      if (this.session.sessionId) this.retainedId = this.session.sessionId;
      if (this.session.loadTranscript && !this.replayed) {
        const replay: ChatMessage[] = [];
        await this.session.loadTranscript((message) => replay.push(message));
        if (replay.length) {
          const knownTurns = new Set(this.state.turns.map((turn) => turn.backendTurnId).filter(Boolean));
          const byId = new Map(this.state.messages.map((m) => [m.id, m]));
          for (const message of replay) {
            if (message.backendTurnId && knownTurns.has(message.backendTurnId)) {
              const turn = this.state.turns.find((item) => item.backendTurnId === message.backendTurnId)!;
              if (message.role === 'user' || !message.backendId) continue;
              const id = `${turn.id}:${message.backendId}`;
              const local = byId.get(id);
              if (local) {
                // A terminal backend snapshot can complete a saved prefix without discarding local metadata.
                if (turn.status === 'completed' && message.text.startsWith(local.text) && message.text.length > local.text.length) byId.set(id, { ...local, text: message.text });
              } else {
                const recovered = { ...message, id, turnId: turn.userMessageId ?? turn.id };
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
      await this.session.listBackgroundTerminals?.().catch(() => undefined);
      this.state.status = 'idle';
    } catch (error) {
      this.state.status = 'error';
        this.state.messages.push({ id: randomUUID(), role: 'error', text: errorMessage(error), at: Date.now() });
    }
    this.publish();
  }

  reset(): Promise<void> {
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
        this.retryInputs.clear();
        this.state.pendingPermission = null;
        this.state.pendingPlan = null;
        this.state.pendingQuestion = null;
        this.state.plan = emptyPlanState();
        this.state.turns = [];
        this.state.subagents = [];
        this.state.terminals = [];
        this.state.terminalError = undefined;
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

  async dispose(): Promise<void> { await this.reset(); }
}
