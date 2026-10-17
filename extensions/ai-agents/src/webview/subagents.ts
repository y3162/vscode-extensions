import type { ViewMessage, ViewShell, ViewSubagent } from '../protocol.js';
import type { Dom } from './dom.js';
import type { Copy, Locale } from './strings.js';
import { formatDuration } from './strings.js';

function statusLabel(item: ViewSubagent, copy: Copy): string {
  if (item.status === 'running') return copy.subagentRunning;
  if (item.status === 'completed') return copy.subagentCompleted;
  if (item.status === 'error') return copy.subagentFailed;
  if (item.status === 'cancelled') return copy.subagentCancelled;
  return copy.subagentUnknown;
}

function statusMark(item: ViewSubagent): string {
  if (item.status === 'completed') return '✓';
  if (item.status === 'error' || item.status === 'cancelled') return '×';
  if (item.status === 'unknown') return '?';
  return '◌';
}

function itemTitle(item: ViewSubagent): string {
  return (item.task || item.name).replace(/\s+/g, ' ').trim() || item.name;
}

function displayName(item: ViewSubagent): string {
  return item.name.split(/[\\/]/).filter(Boolean).at(-1) || item.name;
}

export class SubagentPanel {
  constructor(
    private readonly dom: Dom,
    readonly element: HTMLElement,
    private readonly onOpen: (id: string) => void,
    private readonly onToggle: (expanded: boolean) => void,
  ) {}

  render(shell: ViewShell, copy: Copy, expanded: boolean): void {
    const previousScroll = this.element.querySelector<HTMLElement>('.subagent-panel-rows')?.scrollTop ?? 0;
    this.element.replaceChildren();
    const unique = [...new Map(shell.subagents.map((item) => [item.id, item])).values()];
    const activeTurns = new Set(unique
      .filter((item) => item.status === 'running' || item.status === 'unknown')
      .map((item) => item.parentTurnId).filter((id): id is string => Boolean(id)));
    const items = unique.filter((item) => item.status === 'running' || item.status === 'unknown'
      || Boolean(item.parentTurnId && activeTurns.has(item.parentTurnId)));
    this.element.hidden = items.length === 0;
    if (!items.length) return;
    const allBackground = items.every((item) => item.background === true);
    const allRunning = items.every((item) => item.status === 'running');
    const label = `${items.length} ${allBackground ? copy.backgroundSubagents : allRunning ? copy.activeSubagents : copy.subagents}`;
    const heading = this.dom.button('subagent-panel-heading', label, expanded ? 'chevron-down' : 'chevron-right');
    heading.setAttribute('aria-expanded', String(expanded));
    heading.addEventListener('click', () => this.onToggle(!expanded));
    this.element.append(heading);
    const rows = this.dom.el('div', 'subagent-panel-rows');
    rows.hidden = !expanded;
    for (const item of items) {
      const row = this.dom.el('div', `subagent-panel-row ${item.status}`);
      row.dataset.subagentId = item.id;
      const open = this.dom.button('subagent-panel-open', '', 'chevron-right');
      open.setAttribute('aria-label', `${itemTitle(item)} · ${statusLabel(item, copy)}`);
      open.title = itemTitle(item);
      open.addEventListener('click', () => this.onOpen(item.id));
      const mark = this.dom.el('span', `subagent-mark ${item.status}`, statusMark(item));
      mark.setAttribute('aria-hidden', 'true');
      const body = this.dom.el('span', 'subagent-panel-copy');
      body.append(this.dom.el('span', 'subagent-panel-title', itemTitle(item)));
      if (item.task && displayName(item) !== item.task) body.append(this.dom.el('span', 'subagent-panel-role', displayName(item)));
      if (item.progress) body.append(this.dom.el('span', 'subagent-panel-progress', item.progress));
      const state = this.dom.el('span', 'subagent-panel-state', statusLabel(item, copy));
      open.replaceChildren(mark, body, state, this.dom.icon('chevron-right'));
      row.append(open);
      rows.append(row);
    }
    rows.scrollTop = previousScroll;
    this.element.append(rows);
  }
}

export function renderSubagentDetail(
  dom: Dom,
  host: HTMLElement,
  item: ViewSubagent,
  messages: readonly ViewMessage[],
  copy: Copy,
  locale: Locale,
  onBack: () => void,
): void {
  host.replaceChildren();
  const page = dom.el('section', 'subagent-detail');
  const head = dom.el('header', 'subagent-detail-head');
  const back = dom.button('back subagent-back', copy.parentConversation, 'arrow-left');
  back.addEventListener('click', onBack);
  const identity = dom.el('div', 'subagent-detail-identity');
  identity.append(dom.el('h2', undefined, displayName(item)), dom.el('span', `subagent-state ${item.status}`, statusLabel(item, copy)));
  const facts = dom.el('div', 'subagent-facts');
  if (item.model) facts.append(dom.el('span', 'pill', item.model));
  const duration = item.durationMs ?? (item.startedAt !== undefined && item.endedAt !== undefined ? item.endedAt - item.startedAt
    : item.status === 'running' && item.startedAt !== undefined ? Date.now() - item.startedAt : undefined);
  if (duration !== undefined && duration >= 0) facts.append(dom.el('span', 'subagent-elapsed', formatDuration(duration)));
  head.append(back, identity, facts);
  page.append(head);
  if (item.task) page.append(section(dom, copy.subagentTask, item.task, 'subagent-task'));
  if (item.taskOmitted) page.append(dom.el('p', 'subagent-history-omitted', copy.subagentTaskOmitted));
  if (item.progress) page.append(section(dom, copy.subagentProgress, item.progress, 'subagent-progress'));
  if (item.historyOmitted) page.append(dom.el('p', 'subagent-history-omitted', copy.subagentHistoryOmitted));
  const ownEvents = messages.filter((message) => message.subagentId === item.id);
  if (ownEvents.length) {
    const history = dom.el('section', 'subagent-event-list');
    history.append(dom.el('h3', undefined, copy.subagentLogs));
    for (const message of ownEvents) {
      const event = dom.el('article', `subagent-event ${message.role}`);
      if (message.tool) {
        event.append(dom.el('div', 'subagent-event-heading', `${message.tool.name} · ${message.tool.status}`));
      } else if (message.role === 'error') {
        event.append(dom.el('div', 'subagent-event-heading error', copy.subagentFailed));
      } else if (message.final) {
        event.append(dom.el('div', 'subagent-event-heading', copy.subagentResult));
      } else if (message.meta?.type === 'thinking') {
        event.append(dom.el('div', 'subagent-event-heading', copy.thought));
      }
      if (message.text) event.append(dom.el('pre', 'subagent-event-text', message.text));
      history.append(event);
    }
    page.append(history);
  } else if (!item.resultPreview && !item.error) {
    page.append(dom.el('p', 'subagent-unavailable', copy.subagentNoTranscript));
  }
  if (item.error) page.append(section(dom, copy.subagentError, item.error, 'subagent-error'));
  if (item.resultPreview) page.append(section(dom, copy.subagentResult, item.resultPreview, 'subagent-result'));
  host.append(page);
  host.lang = locale;
}

function section(dom: Dom, title: string, value: string, className: string): HTMLElement {
  const block = dom.el('section', `subagent-detail-section ${className}`);
  block.append(dom.el('h3', undefined, title), dom.el('pre', 'subagent-detail-text', value));
  return block;
}
