import type { Dom } from './dom.js';
import { renderMarkdown } from './markdown.js';
import type { ViewPlan, ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';
import type { Post } from './cards.js';

export function renderPlanView(
  host: HTMLElement,
  shell: ViewShell,
  dom: Dom,
  copy: Copy,
  post: Post,
  onPickModel: (anchor: HTMLElement) => void,
  expanded: boolean,
  onToggle: (expanded: boolean) => void,
): void {
  const plan = shell.planView;
  if (!plan) {
    if (host.childElementCount) host.replaceChildren();
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const signature = JSON.stringify({
    id: plan.id, revision: plan.revision, phase: plan.phase, name: plan.name, overview: plan.overview,
    markdown: plan.markdown, files: plan.files, restored: plan.restored, source: plan.source,
    expanded,
    canBuild: plan.canBuild, showBuildModel: plan.showBuildModel, model: plan.buildModelId,
    modelLabel: plan.buildModelLabel, params: plan.buildParams, todos: plan.todos,
    error: plan.error, history: plan.history,
  });
  if (host.dataset.signature === signature && host.childElementCount) return;
  host.dataset.signature = signature;
  host.replaceChildren();
  const blocked = !plan.canBuild && (Boolean(plan.error) || plan.phase === 'unknown');
  const card = dom.el('section', `plan-view phase-${plan.phase}${blocked ? ' is-blocked' : ''}${plan.canBuild ? ' is-ready' : ''}`);
  if (plan.error) card.append(dom.el('p', 'plan-error', plan.error));
  const head = dom.el('div', 'plan-head');
  head.append(dom.el('h2', undefined, plan.name || copy.plan));
  head.append(dom.el('span', 'plan-phase', phaseLabel(plan, copy)));
  card.append(head);
  if (plan.restored) card.append(dom.el('p', 'note', copy.planRestored));
  if (expanded) {
    card.append(dom.el('p', 'plan-source', `${copy.planSource}: ${sourceLabel(plan.source)}`));
    const body = dom.el('div', 'md plan-body');
    renderMarkdown(body, `${plan.overview ? `${plan.overview}\n\n` : ''}${plan.markdown}`, dom, copy.copy);
    card.append(body);
    if (plan.todos.length) card.append(todoBlock(plan, dom, copy));
    if (plan.files?.length) {
      const files = dom.el('ul', 'plan-files');
      for (const file of plan.files) files.append(dom.el('li', undefined, file));
      card.append(files);
    }
  } else {
    const summary = summaryText(plan);
    if (summary) card.append(dom.el('p', 'plan-summary', summary));
  }
  const actions = dom.el('div', 'plan-actions');
  const view = dom.button('secondary plan-view-toggle', expanded ? copy.backToChat : copy.viewPlan, expanded ? 'arrow-left' : 'book');
  view.setAttribute('aria-expanded', String(expanded));
  view.addEventListener('click', () => onToggle(!expanded));
  actions.append(view);
  const buildGroup = dom.el('div', 'plan-build');
  if (expanded && plan.showBuildModel) {
    const model = dom.button('pill', plan.buildModelLabel || copy.model, 'chevron-down');
    model.disabled = !plan.canBuild;
    if (!plan.canBuild) {
      const reason = plan.phase === 'unknown' ? copy.planUnknown : copy.planNotReady;
      model.title = reason;
      model.setAttribute('aria-label', `${plan.buildModelLabel || copy.model}. ${reason}`);
    }
    model.addEventListener('click', () => onPickModel(model));
    buildGroup.append(model);
  }
  const build = dom.button(plan.canBuild ? 'build' : 'build is-blocked', copy.build);
  const buildReason = plan.canBuild ? copy.build : plan.phase === 'unknown' ? copy.planUnknown : copy.planNotReady;
  build.disabled = !plan.canBuild;
  build.title = buildReason;
  build.setAttribute('aria-label', plan.canBuild ? copy.build : `${copy.build}. ${buildReason}`);
  build.addEventListener('click', () => {
    build.disabled = true;
    post({ type: 'buildPlan', planId: plan.id, revision: plan.revision, modelId: plan.buildModelId, modelParams: plan.buildParams, label: plan.buildModelLabel });
  });
  buildGroup.append(build);
  actions.append(buildGroup);
  card.append(actions);
  if (expanded && plan.history.length) {
    const past = dom.el('details', 'plan-history');
    past.append(dom.el('summary', undefined, copy.planHistory));
    for (const item of plan.history) {
      const block = dom.el('div', 'plan-old');
      block.append(dom.el('h3', undefined, item.name || `${copy.plan} ${item.revision}`));
      const text = dom.el('div', 'md');
      renderMarkdown(text, item.markdown, dom, copy.copy);
      block.append(text);
      past.append(block);
    }
    card.append(past);
  }
  host.append(card);
}

function summaryText(plan: NonNullable<ViewShell['planView']>): string {
  const source = plan.overview?.trim() || plan.markdown;
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text;
}

function todoBlock(plan: ViewPlan, dom: Dom, copy: Copy): HTMLElement {
  const done = plan.todos.filter((todo) => todo.status === 'completed' || todo.status === 'done').length;
  const wrap = dom.el('div', 'plan-todos');
  wrap.append(dom.el('p', 'todo-progress', `${done} / ${plan.todos.length} ${copy.todos}`));
  const list = dom.el('ul', 'todos');
  for (const todo of plan.todos) {
    const complete = todo.status === 'completed' || todo.status === 'done';
    const row = dom.el('li', complete ? 'done' : todo.status === 'in_progress' || todo.status === 'inProgress' ? 'active' : undefined, todo.content);
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

function phaseLabel(plan: ViewPlan, copy: Copy): string {
  if (plan.phase === 'planning' || plan.phase === 'revising') return copy.planUpdating;
  if (plan.phase === 'building') return copy.planBuilding;
  if (plan.phase === 'implemented') return copy.planImplemented;
  if (plan.phase === 'ready') return copy.planReady;
  if (plan.phase === 'unknown') return copy.planUnknown;
  return plan.source;
}

function sourceLabel(source: ViewPlan['source']): string {
  switch (source) {
    case 'acp-create-plan': return 'Cursor ACP create_plan';
    case 'sdk-createPlan': return 'Cursor SDK createPlan';
    case 'app-server-plan': return 'Codex App Server plan item';
    case 'assistant-text': return 'Assistant message fallback';
    default: return source;
  }
}
