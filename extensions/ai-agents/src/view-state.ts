import path from 'node:path';
import type { AgentControls, ProviderCapabilities } from './capabilities.js';
import { isInsideWorkspace } from './change-review.js';
import type { MessageDiff, ViewChange, ViewChoice, ViewMessage, ViewShell } from './protocol.js';
import { formatToken, parameterRole } from './model-settings.js';
import type { ViewPlan, ViewSubagent, ViewTerminal, ViewTurnTiming } from './protocol.js';
import type { Backend, ChatMessage, ChatState, FileChange, Provider, SessionSummary } from './types.js';

export interface InteractionTokens {
  permission: string | null;
  plan: string | null;
  question: string | null;
}

export interface ShellSource {
  state: ChatState;
  folders: { name: string; path: string }[];
  modelLabel: string;
  hasModelDetails: boolean;
  capabilities: ProviderCapabilities;
  controls: AgentControls;
  locale: 'ja' | 'en';
  sessionId?: string;
  activeFile?: { label: string; token: string } | null;
  dismissedWarning?: string | null;
  tokens: InteractionTokens;
  backends: Record<Provider, Backend>;
  conversationId?: string;
  showBuildModel?: boolean;
}

const genericTitles = new Set(['', 'Codex', 'Cursor', 'Cursor ACP']);
const syntheticPaths = new Set(['turn.diff', 'patch']);

export function backendLabel(backend: Backend): string {
  if (backend === 'acp') return 'ACP';
  if (backend === 'app-server') return 'App Server';
  return 'SDK';
}

export function effortText(params: { id: string; value: string }[] | undefined, hasDetails: boolean, locale: 'ja' | 'en'): string | null {
  const effort = params?.find((param) => parameterRole(param.id) === 'effort');
  if (effort) return formatToken(effort.value);
  return null;
}

export function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export function presentChange(change: FileChange, roots: string[]): ViewChange {
  const base = path.basename(change.path) || change.path;
  const outside = path.isAbsolute(change.path) && roots.length > 0 && !isInsideWorkspace(change.path, roots);
  const synthetic = syntheticPaths.has(change.path) || syntheticPaths.has(base) || outside;
  const counted = change.additions !== undefined || change.deletions !== undefined
    ? { ...(change.additions !== undefined ? { additions: change.additions } : {}), ...(change.deletions !== undefined ? { deletions: change.deletions } : {}) }
    : change.diff ? countDiff(change.diff) : {};
  const hasBaseline = change.previousText !== undefined;
  return {
    path: change.path,
    name: synthetic ? 'Patch' : base,
    kind: change.kind,
    ...counted,
    canRevert: !synthetic && hasBaseline,
    canDiff: !synthetic && hasBaseline,
    synthetic,
    ...(synthetic && change.diff ? { patch: change.diff.slice(0, 4000) } : {}),
  };
}

function presentPlan(state: ChatState, showBuildModel: boolean): ViewPlan | null {
  const drafting = state.plan.phase === 'planning' || state.plan.phase === 'revising';
  const visible = drafting ? state.plan.draft ?? state.plan.current : state.plan.current;
  if (!visible?.markdown) return null;
  const selection = state.plan.build?.selection ?? state.selection;
  return {
    id: visible.id,
    revision: visible.revision,
    phase: state.plan.phase,
    ...(visible.name ? { name: visible.name } : {}),
    ...(visible.overview ? { overview: visible.overview } : {}),
    markdown: visible.markdown,
    todos: visible.todos,
    ...(visible.files?.length ? { files: visible.files } : {}),
    ...(visible.restored ? { restored: true } : {}),
    source: visible.source,
    buildModelId: selection.model,
    buildModelLabel: state.plan.build?.label || selection.model || '',
    buildParams: selection.modelParams ?? [],
    showBuildModel,
    canBuild: state.plan.phase === 'ready' && !state.busy,
    ...(state.plan.error ? { error: state.plan.error } : {}),
    history: state.plan.revisions.filter((item) => item.revision !== visible.revision).map((item) => ({
      revision: item.revision,
      ...(item.name ? { name: item.name } : {}),
      markdown: item.markdown,
    })),
  };
}

function choice(id: string, label: string, description?: string): ViewChoice {
  return description ? { id, label, description } : { id, label };
}

function statusText(state: ChatState, locale: 'ja' | 'en', folderReady: boolean): string {
  const waiting = Boolean(state.pendingPermission || state.pendingPlan || state.pendingQuestion);
  const ja = locale === 'ja';
  const operation = state.operationLabel ? ({
    'rewind-check': ja ? '巻き戻し可否を確認中…' : 'Checking rewind safety…',
    'rewind-branch': ja ? '会話を分岐中…' : 'Branching conversation…',
    'rewind-files': ja ? 'ファイルを復元中…' : 'Restoring files…',
    'rewind-prepare': ja ? '編集した依頼を準備中…' : 'Preparing edited prompt…',
    'rewind-send': ja ? '編集した依頼を実行中…' : 'Running edited prompt…',
  } as const)[state.operationLabel] : undefined;
  const base = operation ?? (waiting ? (ja ? '承認待ち' : 'Waiting for approval')
    : state.status === 'cancelling' ? (ja ? '停止中…' : 'Stopping…')
      : state.status === 'restoring' ? (ja ? '復元中…' : 'Restoring…')
        : state.status === 'error' ? (ja ? 'エラー' : 'Error')
          : state.busy ? (ja ? '実行中…' : 'Running…')
            : folderReady ? (ja ? '準備完了' : 'Ready')
              : (ja ? '作業フォルダを開いてください' : 'Open a workspace folder'));
  const usage = state.usage ? ` · in ${state.usage.inputTokens} / out ${state.usage.outputTokens}` : '';
  return base + usage;
}

function sessionTitle(state: ChatState, sessions: SessionSummary[], sessionId: string | undefined, locale: 'ja' | 'en'): string {
  const saved = sessionId ? sessions.find((session) => session.id === sessionId && session.provider === state.selection.provider) : undefined;
  if (saved?.title && !genericTitles.has(saved.title)) return saved.title;
  const first = state.messages.find((message) => message.role === 'user')?.text.split('\n')[0]?.trim();
  if (first) return first.slice(0, 80);
  return locale === 'ja' ? '新しいチャット' : 'New chat';
}

function accessOf(source: ShellSource): { label: string; risky: boolean; banner: ViewShell['banner'] } {
  const { controls, capabilities, locale, state } = source;
  const ja = locale === 'ja';
  const sandbox = capabilities.sandbox.find((item) => item.id === controls.sandbox)?.label ?? controls.sandbox;
  const approval = capabilities.approval.find((item) => item.id === controls.approval)?.label ?? controls.approval;
  let label = sandbox;
  if (source.state.selection.provider === 'codex' && capabilities.approval.length > 1) label = `${sandbox} · ${approval}`;
  if (source.state.selection.provider === 'cursor' && capabilities.interactiveApproval) {
    label = `${sandbox} · ${ja ? 'ツールごとに確認' : 'Approve tools'}`;
  }
  const risky = state.autoApprove || controls.sandbox === 'danger-full-access' || controls.sandbox === 'disabled';
  const id = `${state.selection.provider}|${controls.sandbox}|${controls.approval}|${state.autoApprove ? 1 : 0}`;
  if (!risky || source.dismissedWarning === id) return { label, risky, banner: null };
  if (state.autoApprove) {
    return {
      label, risky, banner: {
        id,
        title: ja ? '自動承認がオンです' : 'Auto-approve is on',
        body: ja
          ? 'ファイルの変更とコマンドを、確認なしで許可します。サンドボックスを無効にしたという意味ではありません。'
          : 'File changes and commands are allowed without a prompt. This does not turn the sandbox off.',
      },
    };
  }
  const off = controls.sandbox === 'disabled';
  return {
    label, risky, banner: {
      id,
      title: off ? (ja ? 'サンドボックスがオフです' : 'Sandbox is off') : (ja ? 'フルアクセスがオンです' : 'Full access is on'),
      body: ja
        ? 'サンドボックスが無効です。確認なしにファイルの変更やコマンドの実行が許可されることがあります。'
        : 'The sandbox is off. File changes and commands may run without a prompt.',
    },
  };
}

export function buildShell(source: ShellSource): ViewShell {
  const { state, capabilities, controls, locale } = source;
  const folder = source.folders.find((item) => item.path === state.selection.cwd);
  const providerName = state.selection.provider === 'cursor' ? 'Cursor' : 'Codex';
  const access = accessOf(source);
  const changes = state.changes.map((change) => presentChange(change, source.folders.map((item) => item.path)));
  const waiting = Boolean(state.pendingPermission || state.pendingPlan || state.pendingQuestion);
  const presence: ViewShell['presence'] = waiting ? 'waiting'
    : state.status === 'error' ? 'error'
      : state.busy || state.status === 'running' || state.status === 'cancelling' || state.status === 'restoring' ? 'running'
        : 'idle';
  const sessions = state.sessions.filter((session) => session.provider === state.selection.provider);
  return {
    provider: state.selection.provider,
    providerLabel: `${providerName} · ${backendLabel(controls.backend)}`,
    cwd: state.selection.cwd,
    busy: state.busy,
    presence,
    statusText: statusText(state, locale, Boolean(folder)),
    ...(state.operationLabel ? { operationLabel: state.operationLabel } : {}),
    sessionTitle: sessionTitle(state, state.sessions, source.sessionId, locale),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    modelLabel: source.modelLabel,
    effortLabel: effortText(state.selection.modelParams, source.hasModelDetails, locale),
    modelSettings: capabilities.modelSettings,
    accessLabel: access.label,
    risky: access.risky,
    banner: access.banner,
    backendLabel: backendLabel(controls.backend),
    folderName: folder?.name ?? (locale === 'ja' ? 'フォルダなし' : 'No folder'),
    folders: source.folders,
    modes: capabilities.modes.map((item) => choice(item.id, item.label, item.description)),
    mode: controls.mode,
    showMode: capabilities.modes.length > 1,
    sandboxChoices: capabilities.sandbox.map((item) => choice(item.id, item.label, item.description)),
    sandbox: controls.sandbox,
    approvalChoices: capabilities.approval.map((item) => choice(item.id, item.label, item.description)),
    approval: controls.approval,
    showApproval: capabilities.approval.length > 1,
    webSearchChoices: capabilities.webSearch.map((item) => choice(item.id, item.label, item.description)),
    webSearch: controls.webSearch,
    showWebSearch: capabilities.webSearch.length > 1,
    network: controls.network,
    showNetwork: capabilities.networkToggle,
    backendChoices: (state.selection.provider === 'cursor'
      ? [choice('sdk', 'SDK'), choice('acp', 'ACP')]
      : [choice('sdk', 'SDK'), choice('app-server', 'App Server')]),
    backend: controls.backend,
    additionalDirectories: controls.additionalDirectories,
    autoApprove: state.autoApprove,
    steer: capabilities.steer,
    interactiveApproval: capabilities.interactiveApproval,
    conversationId: source.conversationId ?? '',
    queue: state.queue.map((item) => ({
      id: item.id,
      text: item.extras?.displayText || item.text,
      images: item.extras?.images?.length ?? 0,
    })),
    changes,
    planView: presentPlan(state, source.showBuildModel !== false && capabilities.buildModel !== 'unsupported'),
    timings: state.turns.map((turn): ViewTurnTiming => ({
      id: turn.id,
      startedAt: turn.startedAt,
      ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
      waitMs: turn.waitMs,
      status: turn.status,
      intent: turn.intent,
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.finalMessageId ? { finalMessageId: turn.finalMessageId } : {}),
    })),
    subagents: state.subagents.map((item): ViewSubagent => ({
      id: item.id,
      ...(item.agentId ? { agentId: item.agentId } : {}),
      ...(item.model ? { model: item.model } : {}),
      name: item.name,
      ...(item.task ? { task: item.task } : {}),
      status: item.status,
      background: item.background,
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.resultPreview ? { resultPreview: item.resultPreview } : {}),
    })),
    terminals: state.terminals.map((item): ViewTerminal => ({
      processId: item.processId,
      ...(item.output ? { output: item.output } : {}),
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.command ? { command: item.command } : {}),
      ...(item.status ? { status: item.status } : {}),
    })),
    ...(state.terminalError ? { terminalError: state.terminalError } : {}),
    additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
    deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
    sessions,
    usage: state.usage,
    permission: state.pendingPermission && source.tokens.permission
      ? { token: source.tokens.permission, request: state.pendingPermission } : null,
    plan: state.pendingPlan && source.tokens.plan ? { token: source.tokens.plan, request: state.pendingPlan } : null,
    question: state.pendingQuestion && source.tokens.question
      ? { token: source.tokens.question, request: state.pendingQuestion } : null,
    activeFile: source.activeFile ?? null,
    locale,
    providers: (['codex', 'cursor'] as const).map((id) => ({
      id,
      label: id === 'cursor' ? 'Cursor' : 'Codex',
      detail: backendLabel(source.backends[id]),
    })),
  };
}

export function toViewMessage(message: ChatMessage, canRewind = false): ViewMessage {
  const meta = message.meta;
  const files = meta?.files?.map((file) => ({
    path: file.path,
    kind: file.kind,
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    ...(file.preview?.length ? { preview: file.preview } : {}),
  }));
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.failure ? { failure: message.failure } : {}),
    ...(message.role === 'user' ? { canRewind } : {}),
    ...(message.at !== undefined ? { at: message.at } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.final ? { final: true } : {}),
    ...(message.tool ? { tool: message.tool } : {}),
    ...(meta ? {
      meta: {
        type: meta.type,
        ...(files?.length ? { files } : {}),
        ...(meta.todos?.length ? { todos: meta.todos } : {}),
        ...(meta.task ? { task: meta.task } : {}),
        ...(meta.imagePath ? { imagePath: meta.imagePath } : {}),
        ...(meta.subagent ? { subagent: {
          id: meta.subagent.id,
          name: meta.subagent.name,
          ...(meta.subagent.task ? { task: meta.subagent.task } : {}),
          status: meta.subagent.status,
          background: meta.subagent.background,
          ...(meta.subagent.durationMs !== undefined ? { durationMs: meta.subagent.durationMs } : {}),
          ...(meta.subagent.resultPreview ? { resultPreview: meta.subagent.resultPreview } : {}),
        } } : {}),
      },
    } : {}),
  };
}

export function messageSignature(message: ViewMessage): string {
  return JSON.stringify(message);
}

export function diffMessages(previous: ReadonlyMap<string, string>, messages: readonly ViewMessage[]): MessageDiff & { next: Map<string, string> } {
  const next = new Map<string, string>();
  const upserts: ViewMessage[] = [];
  const order: string[] = [];
  for (const message of messages) {
    const signature = messageSignature(message);
    next.set(message.id, signature);
    order.push(message.id);
    if (previous.get(message.id) !== signature) upserts.push(message);
  }
  const removed: string[] = [];
  for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
  return { removed, upserts, order, next };
}
