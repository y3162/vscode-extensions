import { renderPending, renderPlanBody, type Post } from './cards.js';
import { renderPlanView } from './plan-view.js';
import { isButton, isElement, type Dom } from './dom.js';
import { renderMarkdown } from './markdown.js';
import type { ViewMessage, ViewShell } from '../protocol.js';
import { countLabel, formatDuration, type Copy, type Locale } from './strings.js';
import { buildTurns, type FileRow, type Segment, type ToolRow, type TurnModel } from './turns.js';
import type { ToolInfo } from '../types.js';

export class Transcript {
  private readonly pending: HTMLElement;
  private readonly planHost: HTMLElement;
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly logSig = new WeakMap<HTMLElement, string>();
  private readonly answerText = new WeakMap<HTMLElement, string>();
  private readonly openLogs = new Set<string>();
  private readonly closedLogs = new Set<string>();
  private readonly openDetails = new Set<string>();
  private turns: TurnModel[] = [];
  private shell: ViewShell | null = null;
  private labels: Copy | null = null;

  constructor(
    private readonly dom: Dom,
    private readonly root: HTMLElement,
    private readonly post: Post,
    private readonly onRetry: (text: string) => void,
    private readonly onPickModel: (anchor: HTMLElement) => void,
  ) {
    this.planHost = dom.el('div', 'plan-slot');
    this.planHost.hidden = true;
    this.pending = dom.el('div', 'pending');
    this.pending.hidden = true;
    this.root.addEventListener('click', (event) => this.onClick(event));
  }

  expandedIds(): string[] { return [...this.openLogs]; }

  restoreExpanded(ids: string[]): void {
    for (const id of ids) this.openLogs.add(id);
  }

  render(messages: readonly ViewMessage[], shell: ViewShell, copy: Copy): void {
    this.shell = shell;
    this.labels = copy;
    if (!this.planHost.parentElement) this.root.append(this.planHost, this.pending);
    const pending = Boolean(shell.permission || shell.plan || shell.question);
    this.turns = buildTurns(messages, shell.busy, pending, shell.timings ?? []);
    const ids = new Set(this.turns.map((turn) => turn.id));
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    this.root.querySelector('.empty')?.remove();
    if (!this.turns.length) this.root.insertBefore(this.empty(copy), this.pending);
    for (const turn of this.turns) this.syncTurn(turn, shell.locale, copy);
    renderPending(this.pending, shell, this.dom, copy, this.post);
    if (shell.plan) renderPlanBody(this.pending, (parent, text) => renderMarkdown(parent, text, this.dom, copy.copy), shell.plan.request.overview, shell.plan.request.plan);
    renderPlanView(this.planHost, shell, this.dom, copy, this.post, this.onPickModel);
    if (this.pending.parentElement !== this.root) this.root.append(this.pending);
    else this.root.append(this.pending);
  }

  private empty(copy: Copy): HTMLElement {
    const wrap = this.dom.el('div', 'empty');
    wrap.append(this.dom.icon('comment-discussion'), this.dom.el('h2', undefined, copy.emptyTitle), this.dom.el('p', 'empty-copy', copy.emptyHint));
    return wrap;
  }

  private syncTurn(turn: TurnModel, locale: Locale, copy: Copy): void {
    let article = this.nodes.get(turn.id);
    if (!article) {
      article = this.dom.el('article', 'turn');
      article.dataset.id = turn.id;
      article.append(this.dom.el('div', 'user-row'), this.logButton(copy), this.dom.el('div', 'log'), this.answerShell(copy), this.dom.el('div', 'errors'));
      this.nodes.set(turn.id, article);
      this.root.insertBefore(article, this.pending);
    }
    article.classList.toggle('done', turn.done);
    const user = article.querySelector('.user-row');
    if (isElement(user)) this.renderUser(user, turn);
    const toggle = article.querySelector('.log-toggle');
    const log = article.querySelector('.log');
    const hasLog = turn.log.length > 0;
    if (isButton(toggle)) {
      toggle.hidden = !hasLog;
      toggle.dataset.turn = turn.id;
      const caption = toggle.querySelector('.btn-label');
      const summary = workSummary(turn, locale, copy);
      if (caption) caption.textContent = summary;
      toggle.setAttribute('aria-label', summary);
      const open = this.logOpen(turn);
      toggle.setAttribute('aria-expanded', String(open && hasLog));
      if (isElement(log)) {
        log.hidden = !open || !hasLog;
        const signature = JSON.stringify(turn.log);
        if (open && this.logSig.get(log) !== signature) {
          this.logSig.set(log, signature);
          this.fillLog(log, turn.log, copy);
        }
      }
    }
    const answer = article.querySelector('.answer');
    if (isElement(answer)) {
      answer.hidden = !turn.answer;
      const markdown = answer.querySelector('.md');
      if (turn.answer && isElement(markdown) && this.answerText.get(markdown) !== turn.answer.text) {
        this.answerText.set(markdown, turn.answer.text);
        renderMarkdown(markdown, turn.answer.text, this.dom, copy.copy);
      }
    }
    const errors = article.querySelector('.errors');
    if (isElement(errors)) this.renderErrors(errors, turn, copy);
  }

  private logButton(copy: Copy): HTMLButtonElement {
    const button = this.dom.button('log-toggle', copy.worked, 'chevron-right');
    button.dataset.action = 'toggle-log';
    return button;
  }

  private answerShell(copy: Copy): HTMLElement {
    const answer = this.dom.el('div', 'answer');
    answer.append(this.dom.el('div', 'md'));
    const copyButton = this.dom.button('ghost copy-answer', copy.copy, 'copy');
    copyButton.dataset.action = 'copy-answer';
    answer.append(copyButton);
    return answer;
  }

  private renderUser(host: HTMLElement, turn: TurnModel): void {
    host.replaceChildren();
    if (!turn.user) { host.hidden = true; return; }
    host.hidden = false;
    const bubble = this.dom.el('div', 'bubble', turn.user.text);
    host.append(bubble);
    if (turn.user.attachments?.length) {
      const row = this.dom.el('div', 'chips');
      for (const attachment of turn.user.attachments) row.append(this.dom.el('span', 'chip', attachment));
      bubble.append(row);
    }
  }

  private renderErrors(host: HTMLElement, turn: TurnModel, copy: Copy): void {
    host.replaceChildren();
    for (const error of turn.errors) {
      const block = this.dom.el('div', 'error-block');
      block.append(this.dom.el('p', undefined, error.text));
      const row = this.dom.el('div', 'card-actions');
      const retry = this.dom.button('secondary tiny', copy.retry);
      retry.dataset.action = 'retry';
      retry.dataset.turn = turn.id;
      const logs = this.dom.button('secondary tiny', copy.logs);
      logs.dataset.action = 'post';
      logs.dataset.type = 'logs';
      const diagnose = this.dom.button('secondary tiny', copy.diagnose);
      diagnose.dataset.action = 'post';
      diagnose.dataset.type = 'diagnose';
      row.append(retry, logs, diagnose);
      block.append(row);
      host.append(block);
    }
  }

  private fillLog(host: HTMLElement, segments: Segment[], copy: Copy): void {
    host.replaceChildren();
    for (const segment of segments) host.append(this.segment(segment, copy));
  }

  private segment(segment: Segment, copy: Copy): HTMLElement {
    switch (segment.type) {
      case 'thinking': {
        const details = this.dom.el('details', 'thinking');
        details.open = true;
        details.append(this.dom.el('summary', undefined, copy.thought), this.dom.el('pre', undefined, segment.text));
        return details;
      }
      case 'subagent': {
        const group = this.dom.el('div', 'subagents');
        group.append(this.dom.el('p', 'subagent-label', copy.subagents));
        for (const item of segment.items) {
          const row = this.dom.el('div', `subagent ${item.status}`);
          const mark = item.status === 'unknown' ? '?' : item.status === 'completed' ? '✓' : item.status === 'error' || item.status === 'cancelled' ? '✕' : '◌';
          const time = item.durationMs ? ` ${formatDuration(item.durationMs)}` : '';
          row.append(this.dom.el('span', undefined, `${mark} ${item.name}${time}`));
          row.title = `${item.agentId ?? item.id}${item.model ? ` · ${item.model}` : ''} · ${item.status}`;
          if (item.model) row.append(this.dom.el('span', 'tool-target', item.model));
          if (item.background === true) row.append(this.dom.el('span', 'tool-target', copy.backgroundAgent));
          if (item.task) row.append(this.dom.el('span', 'tool-target', item.task));
          if (item.resultPreview) row.append(this.dom.el('span', 'tool-target', item.resultPreview));
          group.append(row);
        }
        return group;
      }
      case 'todo': {
        const list = this.dom.el('ul', 'todos');
        for (const item of segment.items) {
          const done = item.status === 'completed' || item.status === 'done';
          const row = this.dom.el('li', done ? 'done' : undefined, item.content);
          list.append(row);
        }
        return list;
      }
      case 'note': return this.dom.el('p', 'note', segment.text);
      case 'text': {
        const block = this.dom.el('div', 'progress-note');
        renderMarkdown(block, segment.text, this.dom, copy.copy);
        return block;
      }
      case 'files': {
        const group = this.dom.el('div', 'file-group');
        for (const file of segment.files) group.append(this.fileRow(file, copy));
        return group;
      }
      case 'tools': {
        const group = this.dom.el('div', 'tool-group');
        for (const tool of segment.tools) group.append(this.toolRow(tool, copy));
        return group;
      }
      default: return this.dom.el('div');
    }
  }

  private fileRow(file: FileRow, copy: Copy): HTMLElement {
    const row = this.dom.el('div', 'file-row');
    const open = this.dom.el('button', 'file-link', file.name);
    open.type = 'button';
    open.dataset.action = 'open-file';
    open.dataset.path = file.path;
    const stats = this.dom.el('span', 'stats', `${file.additions !== undefined ? `+${file.additions}` : ''} ${file.deletions !== undefined ? `−${file.deletions}` : ''}`.trim());
    const diff = this.dom.button('ghost tiny', copy.diff);
    diff.dataset.action = 'open-diff';
    diff.dataset.path = file.path;
    row.append(open, stats, diff);
    return row;
  }

  private toolRow(tool: ToolRow, copy: Copy): HTMLElement {
    const row = this.dom.el('div', `tool-row-item ${tool.status === 'error' ? 'is-error' : tool.status === 'running' ? 'is-running' : 'is-done'}`);
    const button = this.dom.el('button', 'tool-line');
    button.type = 'button';
    button.dataset.action = 'toggle-tool';
    button.dataset.id = tool.id;
    button.append(this.dom.icon(toolIcon(tool.kind)));
    button.append(this.dom.el('span', 'tool-name', tool.name));
    if (tool.target) button.append(this.dom.el('span', 'tool-target', tool.target));
    button.append(this.dom.icon(tool.status === 'running' ? 'loading~spin' : tool.status === 'error' ? 'error' : 'check'));
    row.append(button);
    const open = this.openDetails.has(tool.id);
    if (open) {
      const lines = tool.detail.split('\n');
      const full = this.openDetails.has(`${tool.id}:all`) || lines.length <= 40;
      row.append(this.dom.el('pre', undefined, full ? tool.detail : lines.slice(0, 40).join('\n')));
      if (!full) {
        const more = this.dom.button('ghost tiny', copy.showMore);
        more.dataset.action = 'more';
        more.dataset.id = tool.id;
        row.append(more);
      }
    }
    return row;
  }

  private logOpen(turn: TurnModel): boolean {
    if (this.openLogs.has(turn.id)) return true;
    if (this.closedLogs.has(turn.id)) return false;
    return !turn.done;
  }

  private onClick(event: Event): void {
    const target = event.target;
    if (!isElement(target)) return;
    const button = target.closest('button');
    if (!isButton(button)) return;
    const action = button.dataset.action;
    if (action === 'toggle-log' && button.dataset.turn) {
      const id = button.dataset.turn;
      if (this.openLogs.has(id) || (!this.closedLogs.has(id) && this.turns.find((turn) => turn.id === id && !turn.done))) {
        this.openLogs.delete(id);
        this.closedLogs.add(id);
      } else {
        this.closedLogs.delete(id);
        this.openLogs.add(id);
      }
      const turn = this.turns.find((item) => item.id === id);
      const shell = this.shell;
      const labels = this.labels;
      if (turn && shell && labels) this.syncTurn(turn, shell.locale, labels);
      return;
    }
    if (action === 'toggle-tool' && button.dataset.id) {
      const id = button.dataset.id;
      if (this.openDetails.has(id)) this.openDetails.delete(id);
      else this.openDetails.add(id);
      this.refreshOpenTurn();
      return;
    }
    if (action === 'more' && button.dataset.id) {
      this.openDetails.add(`${button.dataset.id}:all`);
      this.refreshOpenTurn();
      return;
    }
    if (action === 'copy-answer' || action === 'copy-code') {
      const source = action === 'copy-code' ? button.closest('.code-block')?.querySelector('code') : button.closest('.answer')?.querySelector('.md');
      if (source?.textContent) void this.dom.document.defaultView?.navigator.clipboard?.writeText(source.textContent).catch(() => undefined);
      return;
    }
    if (action === 'retry' && button.dataset.turn) {
      const text = this.turns.find((turn) => turn.id === button.dataset.turn)?.user?.text;
      if (text) this.onRetry(text);
      return;
    }
    if (action === 'post' && button.dataset.type) { this.post({ type: button.dataset.type }); return; }
    if ((action === 'open-file' || action === 'open-diff') && button.dataset.path) {
      const line = Number(button.dataset.line);
      const column = Number(button.dataset.column);
      this.post({ type: action === 'open-file' ? 'openFile' : 'openDiff', path: button.dataset.path, ...(line ? { line } : {}), ...(column ? { column } : {}) });
    }
  }

  private refreshOpenTurn(): void {
    const shell = this.shell;
    const labels = this.labels;
    if (!shell || !labels) return;
    for (const turn of this.turns) {
      const log = this.nodes.get(turn.id)?.querySelector('.log');
      if (isElement(log)) this.logSig.delete(log);
      this.syncTurn(turn, shell.locale, labels);
    }
  }
}

function workSummary(turn: TurnModel, locale: Locale, copy: Copy): string {
  const running = turn.log.flatMap((segment) => segment.type === 'tools' ? segment.tools : []).find((tool) => tool.status === 'running');
  if (!turn.done) return running ? `${running.name}…` : copy.working;
  const elapsed = turn.startedAt !== undefined && turn.endedAt !== undefined
    ? Math.max(0, turn.endedAt - turn.startedAt - (turn.waitMs ?? 0)) : 0;
  return elapsed > 0 ? `${copy.worked} ${formatDuration(elapsed)}` : copy.worked;
}

function toolSummary(tools: ToolRow[], locale: Locale): string {
  const counts = new Map<ToolInfo['kind'], number>();
  for (const tool of tools) counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 0).map(([kind, count]) => countLabel(locale, kind, count)).join(' · ');
}

function toolIcon(kind: ToolInfo['kind']): string {
  switch (kind) {
    case 'read': return 'file';
    case 'edit': return 'edit';
    case 'search': return 'search';
    case 'shell': return 'terminal';
    case 'git': return 'git-commit';
    case 'mcp': return 'plug';
    case 'subagent': return 'account';
    default: return 'tools';
  }
}
