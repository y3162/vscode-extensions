import { randomUUID } from 'node:crypto';
import type { AgentMode, PlanDocument, PlanSource, PlanState, Selection, TodoEntry, TurnIntent } from './types.js';
import { emptyPlanState } from './types.js';

export const maxPlanRevisions = 5;

export interface PlanDraft {
  name?: string;
  overview?: string;
  markdown: string;
  todos?: TodoEntry[];
  files?: string[];
  source: PlanSource;
}

export function inferIntent(mode: AgentMode, plan: PlanState): TurnIntent {
  if (mode !== 'plan') return 'chat';
  if (plan.phase === 'ready' || plan.phase === 'implemented' || plan.phase === 'revising') return 'revise';
  return 'plan';
}

export function beginPlanning(state: PlanState): PlanState {
  if (state.phase === 'building') return state;
  return { ...state, phase: state.current ? 'revising' : 'planning', revisionBasePhase: state.revisionBasePhase ?? (state.phase === 'implemented' ? 'implemented' : 'ready'), draft: undefined, error: undefined };
}

export function stageDraft(state: PlanState, draft: PlanDraft, now = Date.now()): PlanState {
  const markdown = draft.markdown.trim();
  if (!markdown) return state;
  const document: PlanDocument = {
    id: state.current?.id ?? state.draft?.id ?? randomUUID(),
    revision: state.current?.revision ?? 0,
    markdown,
    todos: draft.todos ?? [],
    source: draft.source,
    ...(state.current?.turnId ? { turnId: state.current.turnId } : state.draft?.turnId ? { turnId: state.draft.turnId } : {}),
    createdAt: state.draft?.createdAt ?? now,
    ...(draft.name ? { name: draft.name } : {}),
    ...(draft.overview ? { overview: draft.overview } : {}),
    ...(draft.files?.length ? { files: draft.files } : {}),
  };
  return { ...state, draft: document };
}

export function commitDraft(state: PlanState, selection: Selection, sessionId?: string, now = Date.now()): PlanState {
  const draft = state.draft;
  if (!draft?.markdown.trim()) return planningFailed(state, '計画は作成されませんでした。');
  const revision = (state.current?.revision ?? 0) + 1;
  const document: PlanDocument = {
    ...draft,
    id: state.current?.id ?? draft.id,
    revision,
    createdAt: now,
    ...(sessionId ? { sessionId } : {}),
  };
  const revisions = [...state.revisions, {
    revision,
    createdAt: now,
    source: draft.source,
    ...(draft.name ? { name: draft.name } : {}),
    markdown: draft.markdown,
  }].slice(-maxPlanRevisions);
  const build = state.build
    ? { selection: cloneSelection(state.build.selection), ...(state.build.label ? { label: state.build.label } : {}) }
    : { selection: cloneSelection(selection) };
  return {
    phase: 'ready',
    current: document,
    revisions,
    build,
  };
}

export function applyPlanTodos(state: PlanState, todos: TodoEntry[]): PlanState {
  if (!todos.length) return state;
  if (state.draft) return { ...state, draft: { ...state.draft, todos } };
  if (state.current) return { ...state, current: { ...state.current, todos } };
  return state;
}

export function planningFailed(state: PlanState, message?: string): PlanState {
  if (state.current) return { ...state, phase: state.revisionBasePhase ?? (state.phase === 'implemented' ? 'implemented' : 'ready'), revisionBasePhase: undefined, draft: undefined, ...(message ? { error: message } : {}) };
  return { ...emptyPlanState(), ...(message ? { error: message } : {}) };
}

export function requestBuild(state: PlanState, planId: string, revision: number, selection: Selection, sessionId?: string, now = Date.now()): { state: PlanState } | { error: string } {
  if (state.phase === 'building') return { error: '実装はすでに始まっています。' };
  if (state.phase !== 'ready' || !state.current) return { error: '計画の準備ができていません。' };
  if (state.current.id !== planId || state.current.revision !== revision) return { error: '表示中の計画と一致しません。' };
  if (state.current.sessionId && sessionId && state.current.sessionId !== sessionId) return { error: '別のセッションの計画は実装できません。' };
  return {
    state: {
      ...state,
      phase: 'building',
      error: undefined,
      build: { ...(state.build ?? { selection }), selection: cloneSelection(selection), label: state.build?.label, startedAt: now },
    },
  };
}

export function finishBuild(state: PlanState, status: 'completed' | 'failed' | 'cancelled'): PlanState {
  if (!state.current) return emptyPlanState();
  if (status === 'completed') return { ...state, phase: 'implemented', draft: undefined, error: undefined };
  return { ...state, phase: 'ready', draft: undefined };
}

export function setBuildSelection(state: PlanState, selection: Selection, label?: string): PlanState {
  if (state.phase !== 'ready' || !state.current) return state;
  return { ...state, build: { selection: cloneSelection(selection), ...(label ? { label } : {}) } };
}

export function buildPrompt(plan: PlanDocument): string {
  const todos = plan.todos.length
    ? plan.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join('\n')
    : '';
  return [
    `Implement the following plan (revision ${plan.revision}).`,
    'Do not create a new plan. Implement this plan as written.',
    plan.name ? `# ${plan.name}` : '',
    plan.overview ?? '',
    plan.markdown,
    todos ? `To-dos:\n${todos}` : '',
  ].filter(Boolean).join('\n\n');
}

export function cloneSelection(selection: Selection): Selection {
  return {
    ...selection,
    ...(selection.modelParams ? { modelParams: selection.modelParams.map((param) => ({ ...param })) } : {}),
  };
}
