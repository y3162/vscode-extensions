import { randomUUID } from 'node:crypto';
import { sameModelParams } from './model-settings.js';
import { upsertSession } from './session-index.js';
import { addUsage, lightMeta } from './providers/details.js';
import { mergeFileChanges } from './change-review.js';
import {
  errorMessage, type AgentInteractions, type AgentMode, type AgentSession, type AgentUpdate, type ChatMessage,
  type ChatState, type ConnectionStatus, type PermissionDecision, type PermissionRequest, type PlanRequest,
  type QuestionRequest, type Selection, type SendExtras, type SessionSummary,
} from './types.js';

type SessionFactory = (selection: Selection) => Promise<AgentSession>;

interface PermissionWait { request: PermissionRequest; token: string; resolve: (decision: PermissionDecision) => void }
interface PlanWait { request: PlanRequest; token: string; resolve: (decision: 'accepted' | 'rejected') => void }
interface QuestionWait { request: QuestionRequest; token: string; resolve: (answers: Record<string, string[]>) => void }

export class ChatController {
  private session?: AgentSession;
  private active?: { abort: AbortController; done: Promise<void> };
  private resetting?: Promise<void>;
  private autoDrain = false;
  private queueTail: Promise<void> = Promise.resolve();
  private replayed = false;
  private readonly allowSession: { kind: string; title: string; detail: string }[] = [];
  private permissionWait: PermissionWait | null = null;
  private planWait: PlanWait | null = null;
  private questionWait: QuestionWait | null = null;
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
  sessionId(): string | undefined { return this.session?.sessionId; }
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
    this.state.sessions = sessions.slice(0, 50);
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
        this.state.messages.push({ id: randomUUID(), role: cancelled ? 'status' : 'error', text: cancelled ? '停止しました。' : errorMessage(error), at: Date.now() });
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
    if (!this.session?.setMode) return !this.session;
    await this.session.setMode(mode);
    return true;
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

  async send(prompt: string, extras?: SendExtras): Promise<void> {
    prompt = prompt.trim();
    if (!prompt) return;
    if (this.active || this.resetting) throw new Error('エージェントは実行中です。');
    const turnId = randomUUID();
    const operation = { abort: new AbortController(), done: Promise.resolve() };
    this.active = operation;
    this.state.busy = true;
    this.state.status = 'running';
    const attachments = extras?.attachments?.map((item) => item.slice(0, 200)).slice(0, 20).filter(Boolean);
    this.state.messages.push({
      id: turnId, role: 'user', text: (extras?.displayText ?? prompt).trim(), at: Date.now(),
      ...(attachments?.length ? { attachments } : {}),
    });
    this.publish();
    operation.done = (async () => {
      try {
        this.session ??= await this.factory({ ...this.state.selection });
        operation.abort.signal.throwIfAborted();
        await this.session.run(prompt, operation.abort.signal, (update) => {
          if (operation.abort.signal.aborted) return;
          this.absorb(update);
          if (update.meta?.type === 'usage' && !update.text) {
            this.publish();
            return;
          }
          const message = this.stamp(turnId, update);
          const existing = this.state.messages.findIndex((item) => item.id === message.id);
          if (existing < 0) this.state.messages.push(message);
          else this.state.messages[existing] = { ...message, at: this.state.messages[existing]?.at ?? message.at };
          this.state.messages = this.state.messages.slice(-300);
          this.publish();
        }, extras);
        if (operation.abort.signal.aborted) this.addStatus('停止しました。');
      } catch (error) {
        const cancelled = operation.abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        this.state.messages.push({
          id: randomUUID(), role: cancelled ? 'status' : 'error',
          text: cancelled ? '停止しました。' : errorMessage(error), at: Date.now(),
        });
        if (!cancelled) this.state.status = 'error';
      } finally {
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

  private addStatus(text: string): void {
    this.state.messages.push({ id: randomUUID(), role: 'status', text, at: Date.now() });
    this.publish();
  }

  private stamp(turnId: string, update: AgentUpdate): ChatMessage {
    return {
      ...update,
      id: `${turnId}:${update.id}`,
      text: update.text.slice(0, 32000),
      meta: lightMeta(update.meta),
      at: Date.now(),
    };
  }

  private absorb(update: AgentUpdate): void {
    if (update.meta?.type === 'usage' && update.meta.usage) this.state.usage = addUsage(this.state.usage, update.meta.usage);
    if (update.meta?.type === 'files' && update.meta.files) this.state.changes = mergeFileChanges(this.state.changes, update.meta.files);
    if (update.meta?.type === 'todo' && update.meta.todos) this.state.todos = update.meta.todos;
  }

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.state.autoApprove) return Promise.resolve('allow-once');
    if (this.allowSession.some((rule) => rule.kind === request.kind && rule.title === request.title && rule.detail === request.detail)) {
      return Promise.resolve('allow-once');
    }
    return new Promise((resolve) => {
      this.permissionWait = { request, token: randomUUID(), resolve };
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
    this.permissionWait = null;
    this.state.pendingPermission = null;
    if (this.state.status === 'waiting_approval') this.state.status = this.active ? 'running' : 'idle';
    pending.resolve(decision === 'allow-session' ? 'allow-session' : decision);
    this.publish();
  }

  requestPlan(request: PlanRequest): Promise<'accepted' | 'rejected'> {
    return new Promise((resolve) => {
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
    this.publish();
  }

  requestAnswers(request: QuestionRequest): Promise<Record<string, string[]>> {
    return new Promise((resolve) => {
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
    this.publish();
  }

  private settleInteractions(): void {
    const permission = this.permissionWait;
    this.permissionWait = null;
    this.state.pendingPermission = null;
    permission?.resolve('deny');
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
      this.session ??= await this.factory({ ...this.state.selection });
      if (this.session.loadTranscript && !this.replayed) {
        this.replayed = true;
        const replay: ChatMessage[] = [];
        await this.session.loadTranscript((message) => replay.push(message));
        if (replay.length) this.state.messages.push(...replay);
        else this.addStatus('セッションは再開しましたが、このバックエンドは表示用の履歴を返しません。続きを入力できます。');
      } else this.addStatus('セッションを再開しました。');
      this.state.status = 'idle';
    } catch (error) {
      this.state.status = 'error';
        this.state.messages.push({ id: randomUUID(), role: 'error', text: errorMessage(error), at: Date.now() });
    }
    this.publish();
  }

  reset(): Promise<void> {
    if (this.resetting) return this.resetting;
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
        this.replayed = false;
        this.allowSession.length = 0;
        await session?.dispose();
        this.state.messages = [];
        this.state.changes = [];
        this.state.todos = [];
        this.state.usage = null;
        this.state.pendingPermission = null;
        this.state.pendingPlan = null;
        this.state.pendingQuestion = null;
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
