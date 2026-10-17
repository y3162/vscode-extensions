import type { Dom } from './dom.js';
import { renderMarkdown } from './markdown.js';
import type { ViewPlan, ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';
import type { Post } from './cards.js';

export function renderPlanView(host: HTMLElement, shell: ViewShell, dom: Dom, copy: Copy, post: Post, onPickModel: (anchor: HTMLElement) => void): void {
  const plan = shell.planView;
  if (!plan) {
    if (host.childElementCount) host.replaceChildren();
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const signature = JSON.stringify({ id: plan.id, revision: plan.revision, phase: plan.phase, markdown: plan.markdown, canBuild: plan.canBuild, model: plan.buildModelId, params: plan.buildParams, todos: plan.todos, error: plan.error });
  if (host.dataset.signature === signature && host.childElementCount) return;
  host.dataset.signature = signature;
  host.replaceChildren();
  const card = dom.el('section', `plan-view phase-${plan.phase}`);
  const head = dom.el('div', 'plan-head');
  head.append(dom.el('h2', undefined, plan.name || copy.plan));
  head.append(dom.el('span', 'plan-phase', phaseLabel(plan, copy)));
  card.append(head);
  if (plan.restored) card.append(dom.el('p', 'note', copy.planRestored));
  if (plan.error) card.append(dom.el('p', 'plan-error', plan.error));
  const body = dom.el('div', 'md plan-body');
  renderMarkdown(body, `${plan.overview ? `${plan.overview}\n\n` : ''}${plan.markdown}`, dom, copy.copy);
  card.append(body);
  if (plan.todos.length) card.append(todoBlock(plan, dom, copy));
  if (plan.files?.length) {
    const files = dom.el('ul', 'plan-files');
    for (const file of plan.files) files.append(dom.el('li', undefined, file));
    card.append(files);
  }
  const actions = dom.el('div', 'plan-actions');
  if (plan.showBuildModel) {
    const model = dom.button('pill', plan.buildModelLabel || copy.model, 'chevron-down');
    model.disabled = !plan.canBuild;
    model.addEventListener('click', () => onPickModel(model));
    actions.append(model);
  }
  const build = dom.button('build', plan.phase === 'ready' && plan.history.length ? copy.build : copy.build);
  build.disabled = !plan.canBuild;
  build.addEventListener('click', () => {
    if (!plan.canBuild) return;
    build.disabled = true;
    post({ type: 'buildPlan', planId: plan.id, revision: plan.revision, modelId: plan.buildModelId, modelParams: plan.buildParams, label: plan.buildModelLabel });
  });
  actions.append(build);
  card.append(actions);
  if (plan.history.length) {
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
  return plan.source;
}
