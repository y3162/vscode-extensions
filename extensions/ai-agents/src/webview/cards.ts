import { isElement, type Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';

export type Post = (message: { type: string; [key: string]: unknown }) => void;

export function renderPending(host: HTMLElement, shell: ViewShell, dom: Dom, copy: Copy, post: Post): void {
  const current = shell.permission ? `permission:${shell.permission.token}`
    : shell.plan ? `plan:${shell.plan.token}`
      : shell.question ? `question:${shell.question.token}` : '';
  if (!current) {
    if (host.childElementCount) host.replaceChildren();
    host.hidden = true;
    return;
  }
  if (host.dataset.token === current && host.childElementCount) return;
  host.dataset.token = current;
  host.hidden = false;
  host.replaceChildren();
  const card = dom.el('section', 'card pending-card');
  card.tabIndex = -1;
  if (shell.permission) {
    const { request, token } = shell.permission;
    card.append(dom.el('h3', undefined, request.title));
    card.append(dom.el('p', 'card-kind', request.kind));
    const detail = dom.el('pre', undefined, request.detail);
    card.append(detail);
    const actions = dom.el('div', 'card-actions');
    for (const [label, decision] of [[copy.allow, 'allow-once'], [copy.allowSession, 'allow-session'], [copy.deny, 'deny']] as const) {
      const button = dom.button('secondary', label);
      button.addEventListener('click', () => post({ type: 'resolvePermission', id: request.id, decision, token }));
      actions.append(button);
    }
    card.append(actions);
  } else if (shell.plan) {
    const { request, token } = shell.plan;
    card.append(dom.el('h3', undefined, request.name || copy.plan));
    const body = dom.el('div', 'md');
    card.append(body);
    const actions = dom.el('div', 'card-actions');
    const approve = dom.button('', copy.approve);
    const reject = dom.button('secondary', copy.reject);
    approve.addEventListener('click', () => post({ type: 'resolvePlan', id: request.id, decision: 'accepted', token }));
    reject.addEventListener('click', () => post({ type: 'resolvePlan', id: request.id, decision: 'rejected', token }));
    actions.append(approve, reject);
    card.append(actions);
    host.append(card);
    return;
  } else if (shell.question) {
    const { request, token } = shell.question;
    card.append(dom.el('h3', undefined, request.title || copy.question));
    for (const question of request.questions) {
      const field = dom.el('fieldset');
      field.append(dom.el('legend', undefined, question.prompt));
      if (!question.options.length) {
        const input = dom.el('input');
        input.type = 'text';
        input.name = question.id;
        field.append(input);
      }
      for (const option of question.options) {
        const label = dom.el('label', 'choice');
        const input = dom.el('input');
        input.type = question.allowMultiple ? 'checkbox' : 'radio';
        input.name = question.id;
        input.value = option.id;
        label.append(input, option.label);
        field.append(label);
      }
      card.append(field);
    }
    const submit = dom.button('', copy.submit);
    submit.addEventListener('click', () => post({ type: 'resolveQuestion', id: request.id, token, answers: answersFrom(card) }));
    card.append(submit);
  }
  host.append(card);
  card.focus();
}

function answersFrom(card: HTMLElement): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const input of card.querySelectorAll('input')) {
    if ((input.type === 'radio' || input.type === 'checkbox') && !input.checked) continue;
    const value = input.type === 'text' ? input.value.trim() : input.value;
    if (!value) continue;
    const list = answers[input.name] ?? [];
    list.push(value);
    answers[input.name] = list;
  }
  return answers;
}

export function renderPlanBody(host: HTMLElement, markdown: (parent: HTMLElement, text: string) => void, overview: string | undefined, plan: string): void {
  const body = host.querySelector('.md');
  if (isElement(body)) markdown(body, `${overview ? `${overview}\n\n` : ''}${plan}`);
}
