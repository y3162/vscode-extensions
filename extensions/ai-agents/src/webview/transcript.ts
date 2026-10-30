import { renderPending, renderPlanBody, type Post } from './cards.js';
import { renderPlanView } from './plan-view.js';
import { isButton, isElement, type Dom } from './dom.js';
import { extensionBadge } from '../diff-stats.js';
import { fileIcon } from './file-icon.js';
import { usageText } from '../usage.js';
import { codeSources, highlightCode, renderMarkdown } from './markdown.js';
import type { ViewMessage, ViewShell } from '../protocol.js';
import { editGroupLabel, exploreLabel, formatDuration, shellGroupLabel, type Copy, type Locale } from './strings.js';
import { buildTurns, workElapsedMs, type FileRow, type Segment, type ToolRow, type TurnModel } from './turns.js';
import type { FileDiffLine, ToolInfo } from '../types.js';

const previewFoldLimit = 7;
const previewHeadLines = 6;

export class Transcript {
  private readonly pending: HTMLElement;
  private readonly planHost: HTMLElement;
  private readonly subagentWait: HTMLElement;
  private readonly nodes = new Map<string, HTMLElement>();
  private readonly logSig = new WeakMap<HTMLElement, Segment[]>();
  private readonly logRunning = new WeakMap<HTMLElement, boolean>();
  private readonly answerText = new WeakMap<HTMLElement, string>();
  private readonly userState = new WeakMap<HTMLElement, NonNullable<TurnModel['user']>>();
  private readonly renderedUsers = new WeakSet<HTMLElement>();
  private readonly errorState = new WeakMap<HTMLElement, TurnModel['errors']>();
  private readonly openLogs = new Set<string>();
  private readonly closedLogs = new Set<string>();
  private readonly openDetails = new Set<string>();
  private readonly thoughtChoices = new Map<string, boolean>();
  private conversationKey: string | null = null;
  private copySequence = 0;
  private readonly copying = new Map<string, HTMLButtonElement>();
  private readonly copySources = new WeakMap<Element, string>();
  private turns: TurnModel[] = [];
  private shell: ViewShell | null = null;
  private labels: Copy | null = null;
  private editingTurnId: string | null = null;
  private editingText = '';

  constructor(
    private readonly dom: Dom,
    private readonly root: HTMLElement,
    private readonly post: Post,
    private readonly onRetry: (text: string, retryId?: string) => void,
    private readonly onPickModel: (anchor: HTMLElement) => void,
    private readonly onRewind: (turnId: string, editedText: string) => void,
    private readonly onOpenSubagent: (id: string) => void = () => {},
    private readonly onTogglePlan: (expanded: boolean) => void = () => {},
    private readonly onPickSessionModel: (anchor: HTMLElement) => void = () => {},
    approvalHost?: HTMLElement,
  ) {
    this.planHost = dom.el('div', 'plan-slot');
    this.planHost.hidden = true;
    this.subagentWait = dom.el('div', 'waiting-subagent');
    this.subagentWait.hidden = true;
    this.subagentWait.setAttribute('role', 'status');
    this.pending = dom.el('div', 'pending');
    this.pending.hidden = true;
    if (approvalHost) approvalHost.append(this.pending);
    this.root.addEventListener('click', (event) => this.onClick(event));
  }

  expandedIds(): string[] { return [...this.openLogs]; }

  restoreExpanded(ids: string[]): void {
    for (const id of ids) this.openLogs.add(id);
  }

  render(messages: readonly ViewMessage[], shell: ViewShell, copy: Copy, planExpanded = false): void {
    const conversationKey = shell.conversationId ?? shell.sessionId ?? shell.cwd;
    if (this.conversationKey !== null && this.conversationKey !== conversationKey) {
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      this.openLogs.clear();
      this.closedLogs.clear();
      this.openDetails.clear();
      this.cancelEditing();
    }
    this.conversationKey = conversationKey;
    this.shell = shell;
    this.labels = copy;
    if (!this.planHost.parentElement) this.root.append(this.planHost);
    if (!this.pending.parentElement) this.root.append(this.pending);
    const pending = Boolean(shell.permission || shell.plan || shell.question);
    this.turns = buildTurns(messages, shell.busy, pending, shell.timings ?? []);
    const ids = new Set(this.turns.map((turn) => turn.id));
    if (this.editingTurnId && !this.turns.some((turn) => turn.id === this.editingTurnId && turn.user)) this.cancelEditing();
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    this.root.querySelector('.empty')?.remove();
    if (!this.turns.length) this.insertInThread(this.empty(copy));
    for (const turn of this.turns) this.syncTurn(turn, shell.locale, copy);
    renderPending(this.pending, shell, this.dom, copy, this.post);
    if (shell.plan) renderPlanBody(this.pending, (parent, text) => renderMarkdown(parent, text, this.dom, copy.copy), shell.plan.request.overview, shell.plan.request.plan);
    renderPlanView(this.planHost, shell, this.dom, copy, this.post, this.onPickModel, planExpanded, this.onTogglePlan);
    this.insertInThread(this.planHost);
    const wait = shell.subagentWaiting;
    this.subagentWait.hidden = !wait;
    if (wait) this.subagentWait.textContent = wait.count !== undefined && wait.count > 1 ? copy.waitingSubagents : copy.waitingSubagent;
    this.insertInThread(this.subagentWait);
    if (this.pending.parentElement === this.root) this.root.append(this.pending);
  }

  private insertInThread(node: HTMLElement): void {
    const anchor = this.pending.parentElement === this.root ? this.pending : null;
    if (anchor) this.root.insertBefore(node, anchor);
    else this.root.append(node);
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
      const assistant = this.dom.el('div', 'assistant');
      assistant.append(this.logButton(copy), this.dom.el('div', 'log'), this.dom.el('div', 'tool-failures'), this.answerShell(copy), this.dom.el('div', 'errors'), this.dom.el('div', 'turn-usage'));
      article.append(this.dom.el('div', 'user-row'), assistant);
      this.nodes.set(turn.id, article);
      this.insertInThread(article);
    }
    article.classList.toggle('done', turn.done);
    const usageHost = article.querySelector('.turn-usage') as HTMLElement;
    const usage = shellUsage(this.shell, turn.id);
    usageHost.textContent = [usage ? usageText(usage) : '', turn.status === 'unknown' ? copy.turnUnknown : ''].filter(Boolean).join(' · ');
    usageHost.hidden = !usage && turn.status !== 'unknown';
    const user = article.querySelector('.user-row');
    if (isElement(user)) this.renderUser(user, turn);
    const toggle = article.querySelector('.log-toggle');
    const log = article.querySelector('.log');
    const hasLog = turn.log.length > 0;
    if (isButton(toggle)) {
      const summary = !turn.done && this.shell?.presence === 'waiting' ? this.shell.statusText : workSummary(turn, locale, copy);
      const showHeader = summary.length > 0;
      toggle.hidden = !showHeader;
      toggle.classList.toggle('is-active', !turn.done);
      toggle.dataset.turn = turn.id;
      toggle.querySelector('.btn-label')!.textContent = summary;
      toggle.setAttribute('aria-label', summary);
      const open = showHeader ? this.logOpen(turn) : hasLog;
      toggle.setAttribute('aria-expanded', String(open && hasLog && showHeader));
      if (isElement(log)) {
        log.hidden = !open || !hasLog;
        const previous = this.logSig.get(log);
        const running = !turn.done && !turn.answer;
        if (!sameSegments(previous, turn.log) || this.logRunning.get(log) !== running) {
          this.logSig.set(log, turn.log);
          this.logRunning.set(log, running);
          this.fillLog(log, turn.id, turn.log, copy, running);
        }
      }
      const failures = article.querySelector('.tool-failures');
      if (isElement(failures)) this.renderFailures(failures, turn, Boolean(open && hasLog));
    }
    const answer = article.querySelector('.answer');
    if (isElement(answer)) {
      answer.hidden = !turn.answer;
      const markdown = answer.querySelector('.md');
      const copyButton = answer.querySelector('.copy-answer');
      if (copyButton && turn.answer) this.copySources.set(copyButton, turn.answer.text);
      if (turn.answer && isElement(markdown)) {
        if (this.answerText.get(markdown) !== turn.answer.text) {
          this.answerText.set(markdown, turn.answer.text);
          renderMarkdown(markdown, turn.answer.text, this.dom, copy.copy);
        }
      }
    }
    const errors = article.querySelector('.errors');
    if (isElement(errors) && !sameErrors(this.errorState.get(errors), turn.errors)) {
      this.errorState.set(errors, turn.errors);
      this.renderErrors(errors, turn, copy);
    }
  }

  private logButton(copy: Copy): HTMLButtonElement {
    const button = this.dom.button('log-toggle', copy.worked, 'chevron-right');
    button.dataset.action = 'toggle-log';
    return button;
  }

  private answerShell(copy: Copy): HTMLElement {
    const answer = this.dom.el('div', 'answer');
    answer.append(this.dom.el('div', 'md'));
    const copyButton = this.dom.button('ghost icon-btn copy-answer', copy.copy, 'copy');
    copyButton.dataset.action = 'copy-answer';
    const actions = this.dom.el('div', 'message-actions');
    actions.append(copyButton);
    answer.append(actions);
    return answer;
  }

  private renderUser(host: HTMLElement, turn: TurnModel): void {
    const editing = this.editingTurnId === turn.id;
    if (editing && host.querySelector('.prompt-editor')) {
      this.syncPromptEditor(host, turn);
      return;
    }
    if (!editing) {
      if (!turn.user && this.renderedUsers.has(host) && host.hidden) return;
      const previous = this.userState.get(host);
      if (turn.user && previous && previous.id === turn.user.id && previous.text === turn.user.text
        && previous.attachments === turn.user.attachments && previous.at === turn.user.at
        && previous.canRewind === turn.user.canRewind && previous.rewindReason === turn.user.rewindReason) {
        const bubble = host.querySelector<HTMLButtonElement>('.bubble');
        if (bubble) bubble.disabled = Boolean(this.shell?.busy);
        return;
      }
      this.renderedUsers.add(host);
      if (turn.user) this.userState.set(host, turn.user);
    } else this.userState.delete(host);
    host.replaceChildren();
    if (!turn.user) { host.hidden = true; return; }
    host.hidden = false;
    if (this.editingTurnId === turn.id) {
      host.append(this.promptEditor(turn));
      return;
    }
    const bubble = this.dom.el('button', 'bubble user-card');
    bubble.type = 'button';
    bubble.dataset.action = 'edit-user';
    bubble.dataset.turn = turn.id;
    bubble.setAttribute('aria-label', this.labels?.editMessage ?? 'Edit message');
    bubble.disabled = Boolean(this.shell?.busy);
    bubble.append(this.dom.el('div', 'user-body', turn.user.text));
    if (turn.user.attachments?.length) {
      const row = this.dom.el('ul', 'chips');
      for (const attachment of turn.user.attachments) {
        const chip = this.dom.el('li', 'chip', basename(attachment));
        chip.title = attachment;
        row.append(chip);
      }
      bubble.append(row);
    }
    const actions = this.dom.el('div', 'user-actions');
    actions.append(this.dom.icon('arrow-right'));
    bubble.append(actions);
    host.append(bubble);
  }

  private promptEditor(turn: TurnModel): HTMLElement {
    const user = turn.user;
    const editor = this.dom.el('div', 'prompt-editor');
    const textarea = this.dom.el('textarea', 'edit-prompt');
    textarea.value = this.editingText;
    textarea.setAttribute('aria-label', this.labels?.editMessage ?? 'Edit message');
    textarea.addEventListener('input', () => {
      if (this.editingTurnId === turn.id) this.editingText = textarea.value;
    });
    editor.append(textarea);
    if (user?.attachments?.length) {
      const attachments = this.dom.el('div', 'chips edit-attachments');
      attachments.setAttribute('aria-label', this.labels?.attachments ?? 'Attachments');
      for (const attachment of user.attachments) attachments.append(this.dom.el('span', 'chip', attachment));
      editor.append(attachments);
    }
    const actions = this.dom.el('div', 'edit-actions');
    const model = this.dom.button('pill model-name edit-model', this.labels?.model ?? 'Model', 'chevron-down');
    model.dataset.action = 'pick-session-model';
    const trailing = this.dom.el('div', 'edit-submit');
    const cancel = this.dom.button('secondary tiny', this.labels?.cancel ?? 'Cancel');
    cancel.dataset.action = 'cancel-edit';
    cancel.dataset.turn = turn.id;
    const resend = this.dom.button('send tiny', this.labels?.resend ?? 'Resend');
    resend.dataset.action = 'rewind';
    resend.dataset.turn = turn.id;
    trailing.append(cancel, resend);
    actions.append(model, trailing);
    editor.append(actions);
    this.syncPromptEditor(editor, turn);
    return editor;
  }

  private syncPromptEditor(host: HTMLElement, turn: TurnModel): void {
    const resend = host.querySelector<HTMLButtonElement>('[data-action="rewind"]');
    if (resend) {
      const canRewind = turn.user?.canRewind === true;
      const label = canRewind ? (this.labels?.resend ?? 'Resend') : (this.labels?.returnToInput ?? 'Return to input');
      const caption = resend.querySelector('.btn-label');
      if (caption) caption.textContent = label;
      resend.disabled = Boolean(this.shell?.busy);
      resend.title = canRewind
        ? (this.labels?.branchFromHere ?? label)
        : (this.labels?.rewindUnavailable ?? 'This turn cannot be safely rewound.');
      resend.setAttribute('aria-label', canRewind ? label : `${label}. ${resend.title}`);
    }
    this.syncEditModel(host.querySelector<HTMLButtonElement>('.edit-model'));
  }

  private syncEditModel(button: HTMLButtonElement | null): void {
    if (!button) return;
    const shell = this.shell;
    const text = shell ? (shell.effortLabel ? `${shell.modelLabel} ${shell.effortLabel}` : shell.modelLabel) : (this.labels?.model ?? 'Model');
    const caption = button.querySelector('.btn-label');
    if (caption) caption.textContent = text;
    button.title = text;
    button.setAttribute('aria-label', text);
    const adjustable = Boolean(shell && shell.modelSettings !== 'unsupported');
    button.classList.toggle('is-static', !adjustable);
    button.setAttribute('aria-haspopup', adjustable ? 'menu' : 'false');
    button.disabled = Boolean(shell?.busy);
  }

  private cancelEditing(): void {
    this.editingTurnId = null;
    this.editingText = '';
  }

  private refreshTurn(id: string): void {
    const turn = this.turns.find((item) => item.id === id);
    const article = this.nodes.get(id);
    const shell = this.shell;
    const labels = this.labels;
    if (turn && article && shell && labels) this.syncTurn(turn, shell.locale, labels);
  }

  private renderFailures(host: HTMLElement, turn: TurnModel, logOpen: boolean): void {
    const lines: string[] = [];
    if (!logOpen) {
      for (const segment of turn.log) {
        for (const tool of segmentTools(segment)) {
          if (tool.status !== 'error') continue;
          const reason = tool.detail.split('\n').map((line) => line.trim()).find(Boolean) || tool.name;
          lines.push(`${tool.name}: ${reason}`);
        }
      }
    }
    const signature = lines.join('\n');
    if (host.dataset.signature === signature) {
      host.hidden = lines.length === 0;
      return;
    }
    host.dataset.signature = signature;
    host.replaceChildren();
    host.hidden = lines.length === 0;
    for (const line of lines) host.append(this.dom.el('p', 'tool-reason', line));
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
      retry.title = '入力を確認して再送します。既に行われた操作は取り消されません。';
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

  private fillLog(host: HTMLElement, turnId: string, segments: Segment[], copy: Copy, running: boolean): void {
    host.replaceChildren();
    for (const [index, segment] of segments.entries()) {
      const active = segment.type === 'thinking'
        ? running && index === segments.length - 1 && !segment.completed && segment.durationMs === undefined
        : running && segmentTools(segment).some((tool) => tool.status === 'running');
      host.append(this.segment(segment, copy, active, turnId));
    }
  }

  private segment(segment: Segment, copy: Copy, running: boolean, turnId: string): HTMLElement {
    switch (segment.type) {
      case 'thinking': {
        const details = this.dom.el('details', 'thinking');
        details.dataset.id = segment.id;
        const key = JSON.stringify([this.conversationKey, turnId, segment.id]);
        details.open = this.thoughtChoices.get(key) ?? running;
        const summary = this.dom.el('summary', 'log-toggle thought-toggle');
        summary.setAttribute('aria-expanded', String(details.open));
        const icon = this.dom.icon('chevron-right');
        const duration = segment.durationMs ?? (running && segment.startedAt !== undefined ? Math.max(0, Date.now() - segment.startedAt) : undefined);
        const label = thoughtLabel(segment.text, duration, running, copy);
        summary.append(icon, this.dom.el('span', 'btn-label', label));
        summary.addEventListener('click', (event) => {
          event.preventDefault();
          details.open = !details.open;
          this.thoughtChoices.set(key, details.open);
          summary.setAttribute('aria-expanded', String(details.open));
        });
        details.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(details.open)));
        details.append(summary, this.dom.el('pre', undefined, segment.text));
        return details;
      }
      case 'explore':
      case 'ran':
      case 'edited':
        return this.activityGroup(segment, copy, running);
      case 'subagent': {
        const group = this.dom.el('div', 'subagents');
        group.append(this.dom.el('p', 'subagent-label', copy.subagents));
        for (const item of segment.items) {
          const row = this.dom.button(`subagent ${item.status}`, '', 'chevron-right');
          row.dataset.subagentId = item.id;
          row.setAttribute('aria-label', `${item.name} · ${item.status}`);
          row.addEventListener('click', () => this.onOpenSubagent(item.id));
          const mark = item.status === 'unknown' ? '?' : item.status === 'completed' ? '✓' : item.status === 'error' || item.status === 'cancelled' ? '✕' : '◌';
          const time = item.durationMs ? ` ${formatDuration(item.durationMs)}` : '';
          row.querySelector('.btn-label')!.textContent = `${mark} ${item.name}${time}`;
          row.title = `${item.agentId ?? item.id}${item.model ? ` · ${item.model}` : ''} · ${item.status}`;
          if (item.model) row.append(this.dom.el('span', 'tool-target', item.model));
          if (item.background === true) row.append(this.dom.el('span', 'tool-target', copy.backgroundAgent));
          if (item.task) row.append(this.dom.el('span', 'tool-target', item.task));
          if (item.progress) row.append(this.dom.el('span', 'tool-target', item.progress));
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
        const additions = segment.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
        const deletions = segment.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
        const hasStats = segment.files.some((file) => file.additions !== undefined || file.deletions !== undefined);
        const label = editGroupLabel(this.shell?.locale ?? 'en', segment.files.map((file) => file.name), running, false, hasStats ? additions : undefined, hasStats ? deletions : undefined);
        const details = this.activityShell('edited', segment.id, label, running);
        const group = this.dom.el('div', 'file-group explore-rows');
        segment.files.forEach((file, index) => group.append(this.fileRow(file, `${segment.id}:${index}`, copy)));
        details.append(group);
        return details;
      }
      case 'tools': {
        const group = this.dom.el('div', 'tool-group');
        for (const tool of segment.tools) group.append(this.toolRow(tool, copy));
        return group;
      }
    }
  }

  private activityGroup(segment: Extract<Segment, { type: 'explore' | 'ran' | 'edited' }>, copy: Copy, running: boolean): HTMLElement {
    const locale = this.shell?.locale ?? 'en';
    const failed = segment.tools.some((tool) => tool.status === 'error');
    const label = segment.tools.some((tool) => tool.status === 'unknown') ? copy.toolUnknown : segment.type === 'explore'
      ? exploreFailureLabel(exploreLabel(locale, segment.tools.filter((tool) => tool.kind === 'read').length, segment.tools.filter((tool) => tool.kind === 'search').length, running), locale, failed)
      : segment.type === 'ran'
        ? shellGroupLabel(locale, segment.tools.map((tool) => tool.target || tool.name), running, failed)
        : editGroupLabel(locale, segment.tools.map((tool) => basename(tool.target || tool.name)), running, failed);
    const details = this.activityShell(segment.type, segment.id, label, running);
    const rows = this.dom.el('div', 'explore-rows');
    for (const tool of segment.tools) rows.append(this.toolRow(tool, copy));
    details.append(rows);
    const block = this.dom.el('div', 'activity-block');
    block.append(details);
    if (!details.open) {
      for (const tool of segment.tools) {
        if (tool.status === 'error') block.append(this.dom.el('p', 'tool-reason', this.toolReason(tool)));
      }
    }
    return block;
  }

  private activityShell(kind: string, id: string, label: string, running: boolean): HTMLDetailsElement {
    const details = this.dom.el('details', `activity-group ${kind}`);
    details.dataset.id = id;
    const closedKey = `${kind}-closed:${id}`;
    const openedKey = `${kind}-open:${id}`;
    details.open = this.openDetails.has(openedKey) || (running && !this.openDetails.has(closedKey));
    const summary = this.dom.el('summary', `log-toggle activity-row ${kind}-toggle`);
    summary.setAttribute('aria-expanded', String(details.open));
    summary.append(this.dom.icon('chevron-right'), this.dom.el('span', 'activity-verb', label));
    details.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(details.open));
      if (details.open) { this.openDetails.add(openedKey); this.openDetails.delete(closedKey); }
      else { this.openDetails.add(closedKey); this.openDetails.delete(openedKey); }
    });
    details.append(summary);
    return details;
  }

  private fileRow(file: FileRow, previewId: string, copy: Copy): HTMLElement {
    const row = this.dom.el('div', 'file-row');
    const header = this.dom.el('div', 'file-header');
    const open = this.dom.el('button', 'file-link', file.name);
    open.type = 'button';
    open.dataset.action = 'open-file';
    open.dataset.path = file.path;
    const stats = this.dom.el('span', 'stats');
    if (file.additions !== undefined) stats.append(this.dom.el('span', 'stats-add', `+${file.additions}`));
    if (file.deletions !== undefined) stats.append(this.dom.el('span', 'stats-remove', `−${file.deletions}`));
    header.append(this.fileMark(file), this.dom.el('span', 'activity-verb', copy.edited), open, stats);
    row.append(header);
    const source = file.preview ?? [];
    if (source.length) {
      const diffKey = `diff:${previewId}`;
      const expanded = this.openDetails.has(diffKey);
      const canFold = source.length > previewFoldLimit;
      const preview = this.dom.el('div', `file-inline-diff${expanded && canFold ? ' is-expanded' : ''}`);
      for (const line of previewLines(source, expanded)) preview.append(this.diffLine(line));
      row.append(preview);
      if (canFold) {
        const toggle = this.dom.button('ghost tiny diff-preview-toggle', expanded ? copy.showLess : copy.showMore);
        toggle.dataset.action = 'toggle-diff';
        toggle.dataset.id = diffKey;
        toggle.setAttribute('aria-expanded', String(expanded));
        row.append(toggle);
      }
    }
    return row;
  }

  private fileMark(file: FileRow): HTMLElement {
    const icon = file.icon;
    if (icon && icon.type !== 'badge') return fileIcon(this.dom, file);
    const badge = this.dom.el('span', 'file-badge', icon?.badge || extensionBadge(file.name));
    badge.dataset.lang = fileLanguage(file.name);
    return badge;
  }

  private diffLine(line: FileDiffLine): HTMLElement {
    const item = this.dom.el('div', `diff-preview-line ${line.kind}`);
    if (line.kind === 'more' || line.kind === 'eof') {
      item.append(this.dom.el('span', 'diff-preview-more', line.text));
      return item;
    }
    const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : '';
    item.append(this.dom.el('span', 'diff-preview-number', line.line === undefined ? '' : String(line.line)));
    item.append(this.dom.el('span', sign ? `diff-preview-sign ${line.kind}` : 'diff-preview-sign', sign));
    item.append(this.dom.el('code', 'diff-preview-text', line.text));
    return item;
  }

  private toolStatus(tool: ToolRow, copy: Copy): HTMLElement {
    const label = tool.status === 'unknown' ? copy.toolUnknown : tool.status === 'running' ? copy.toolRunning : tool.status === 'error' ? copy.toolFailed : copy.toolDone;
    return this.dom.el('span', 'tool-state', label);
  }

  private toolRow(tool: ToolRow, copy: Copy): HTMLElement {
    const row = this.dom.el('div', `tool-row-item ${tool.status === 'error' ? 'is-error' : tool.status === 'running' ? 'is-running' : tool.status === 'unknown' ? 'is-unknown' : 'is-done'}`);
    if (tool.kind === 'shell' && tool.target) {
      row.classList.add('shell-tool');
      const command = tool.target;
      const open = this.openDetails.has(tool.id);
      const button = this.dom.el('button', 'tool-line shell-tool-heading');
      button.type = 'button';
      button.dataset.action = 'toggle-tool';
      button.dataset.id = tool.id;
      button.setAttribute('aria-expanded', String(open));
      button.append(this.dom.icon(open ? 'chevron-down' : 'chevron-right'));
      button.append(this.dom.el('span', 'tool-name', shellCaption(command, copy)));
      if (tool.status !== 'completed') button.append(this.dom.icon(tool.status === 'running' ? 'loading~spin' : tool.status === 'unknown' ? 'question' : 'error'));
      button.append(this.toolStatus(tool, copy));
      row.append(button);
      if (!open) {
        if (tool.status === 'error') row.append(this.dom.el('p', 'tool-reason', this.toolReason(tool)));
        return row;
      }
      const commandLine = this.dom.el('div', 'shell-command-line');
      commandLine.append(this.dom.el('span', 'shell-prompt', '$'));
      const code = this.dom.el('code');
      if (command.length > 12000) code.textContent = command;
      else code.append(highlightCode(command, 'sh', this.dom));
      commandLine.append(code);
      row.append(commandLine);
      const output = shellOutput(tool.detail, command);
      if (output) {
        const pre = this.dom.el('pre', 'shell-command-output', output);
        row.append(pre);
        const copyButton = this.dom.button('ghost tiny', copy.copy, 'copy');
        copyButton.dataset.action = 'copy-source'; this.copySources.set(copyButton, output); row.append(copyButton);
      }
      return row;
    }
    const button = this.dom.el('button', 'tool-line');
    button.type = 'button';
    const openRead = tool.kind === 'read' && Boolean(tool.target);
    button.dataset.action = openRead ? 'open-file' : 'toggle-tool';
    if (openRead && tool.target) {
      button.dataset.path = tool.target;
      if (tool.line !== undefined) button.dataset.line = String(tool.line);
      if (tool.endLine !== undefined) button.dataset.endLine = String(tool.endLine);
      button.title = `Open ${tool.target}${tool.line ? `:${tool.line}${tool.endLine && tool.endLine !== tool.line ? `-${tool.endLine}` : ''}` : ''}`;
    } else button.dataset.id = tool.id;
    const label = activityLabel(tool, copy);
    button.append(this.dom.icon(toolIcon(tool.kind)));
    button.append(this.dom.el('span', 'tool-name', label));
    const base = tool.target ? basename(tool.target) : '';
    if (tool.target && base && !label.toLowerCase().includes(base.toLowerCase()) && !label.toLowerCase().includes(tool.target.toLowerCase())) {
      const range = tool.line ? ` L${tool.line}${tool.endLine && tool.endLine !== tool.line ? `-${tool.endLine}` : ''}` : '';
      button.append(this.dom.el('span', 'tool-target', `${tool.target}${range}`));
    }
    if (tool.status !== 'completed') button.append(this.dom.icon(tool.status === 'running' ? 'loading~spin' : tool.status === 'unknown' ? 'question' : 'error'));
    button.append(this.toolStatus(tool, copy));
    row.append(button);
    const open = this.openDetails.has(tool.id);
    if (open) {
      const lines = tool.detail.split('\n');
      const full = this.openDetails.has(`${tool.id}:all`) || lines.length <= 40;
      row.append(this.dom.el('pre', undefined, full ? tool.detail : lines.slice(0, 40).join('\n')));
      const copyButton = this.dom.button('ghost tiny', copy.copy, 'copy');
      copyButton.dataset.action = 'copy-source'; this.copySources.set(copyButton, tool.detail); row.append(copyButton);
      if (!full) {
        const more = this.dom.button('ghost tiny', copy.showMore);
        more.dataset.action = 'more';
        more.dataset.id = tool.id;
        row.append(more);
      }
    } else if (tool.status === 'error') row.append(this.dom.el('p', 'tool-reason', this.toolReason(tool)));
    return row;
  }

  private toolReason(tool: ToolRow): string {
    return tool.detail.split('\n').map((line) => line.trim()).find(Boolean) || tool.name;
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
      const turn = this.turns.find((item) => item.id === id);
      const closing = turn ? this.logOpen(turn) : this.openLogs.has(id);
      if (closing) {
        this.openLogs.delete(id);
        this.closedLogs.add(id);
        const log = this.nodes.get(id)?.querySelector('.log');
        log?.querySelectorAll<HTMLDetailsElement>('details.thinking').forEach((details) => {
          details.open = false;
          details.querySelector('summary')?.setAttribute('aria-expanded', 'false');
          if (details.dataset.id) this.thoughtChoices.set(JSON.stringify([this.conversationKey, id, details.dataset.id]), false);
        });
      } else {
        this.closedLogs.delete(id);
        this.openLogs.add(id);
      }
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
    if (action === 'toggle-diff' && button.dataset.id) {
      const id = button.dataset.id;
      if (this.openDetails.has(id)) this.openDetails.delete(id);
      else this.openDetails.add(id);
      this.refreshOpenTurn();
      return;
    }
    if (action === 'copy-answer' || action === 'copy-code' || action === 'copy-source') {
      const code = button.closest('.code-block');
      const text = action === 'copy-code' && code ? codeSources.get(code) : this.copySources.get(button);
      if (text === undefined) return;
      const requestId = `copy-${++this.copySequence}`;
      this.copying.set(requestId, button); button.disabled = true;
      this.post({ type: 'copy', requestId, text });
      return;
    }
    if (action === 'pick-session-model') {
      if (!this.shell || this.shell.busy || this.shell.modelSettings === 'unsupported') return;
      this.onPickSessionModel(button);
      return;
    }
    if (action === 'edit-user' && button.dataset.turn) {
      const turn = this.turns.find((item) => item.id === button.dataset.turn);
      if (this.shell?.busy || !turn?.user) return;
      const previousId = this.editingTurnId;
      this.editingTurnId = turn.id;
      this.editingText = turn.user.text;
      if (previousId && previousId !== turn.id) this.refreshTurn(previousId);
      this.refreshTurn(turn.id);
      this.nodes.get(turn.id)?.querySelector<HTMLTextAreaElement>('.edit-prompt')?.focus();
      return;
    }
    if (action === 'cancel-edit' && button.dataset.turn === this.editingTurnId) {
      const id = this.editingTurnId;
      this.cancelEditing();
      if (id) this.refreshTurn(id);
      return;
    }
    if (action === 'rewind' && button.dataset.turn === this.editingTurnId && !this.shell?.busy) {
      const id = button.dataset.turn!;
      const textarea = button.closest('.prompt-editor')?.querySelector('textarea');
      const editedText = isElement(textarea) && textarea.tagName === 'TEXTAREA' ? (textarea as HTMLTextAreaElement).value : this.editingText;
      const turn = this.turns.find((item) => item.id === id);
      if (turn?.user?.canRewind === true) this.onRewind(id, editedText);
      else {
        this.onRetry(editedText, id);
        this.post({ type: 'prepareResend', id });
      }
      this.cancelEditing();
      this.refreshTurn(id);
      return;
    }
    if (action === 'retry' && button.dataset.turn) {
      const text = this.turns.find((turn) => turn.id === button.dataset.turn)?.user?.text;
      if (text !== undefined && !this.shell?.busy) { this.onRetry(text, button.dataset.turn); this.post({ type: 'prepareRetry', id: button.dataset.turn }); }
      return;
    }
    if (action === 'post' && button.dataset.type) { this.post({ type: button.dataset.type }); return; }
    if ((action === 'open-file' || action === 'open-diff') && button.dataset.path) {
      const line = Number(button.dataset.line);
      const endLine = Number(button.dataset.endLine);
      const column = Number(button.dataset.column);
      this.post({ type: action === 'open-file' ? 'openFile' : 'openDiff', path: button.dataset.path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(column ? { column } : {}) });
    }
  }

  copied(requestId: string, ok: boolean): void {
    const button = this.copying.get(requestId); if (!button) return;
    this.copying.delete(requestId); button.disabled = false;
    button.title = ok ? this.labels?.copied ?? 'Copied' : this.shell?.locale === 'ja' ? 'コピーに失敗しました' : 'Copy failed';
    button.querySelector('.codicon')!.className = `codicon codicon-${ok ? 'check' : 'error'}`;
    button.querySelector('.btn-label')!.textContent = button.title;
    button.setAttribute('aria-label', button.title);
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

function sameErrors(previous: TurnModel['errors'] | undefined, next: TurnModel['errors']): boolean {
  return previous !== undefined && previous.length === next.length
    && previous.every((item, index) => item.id === next[index]?.id && item.text === next[index]?.text);
}

function sameSegments(previous: Segment[] | undefined, next: Segment[]): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((left, index) => {
    const right = next[index];
    if (!right || left.type !== right.type || left.id !== right.id) return false;
    switch (left.type) {
      case 'thinking': return right.type === 'thinking' && left.text === right.text && left.completed === right.completed && left.startedAt === right.startedAt && left.durationMs === right.durationMs;
      case 'note': return right.type === 'note' && left.text === right.text;
      case 'text': return right.type === 'text' && left.text === right.text && left.final === right.final;
      case 'tools':
      case 'explore':
      case 'ran':
      case 'edited': {
        if (right.type !== left.type || (right.type !== 'tools' && right.type !== 'explore' && right.type !== 'ran' && right.type !== 'edited')) return false;
        return left.tools.length === right.tools.length && left.tools.every((tool, toolIndex) => {
          const candidate = right.tools[toolIndex];
          return Boolean(candidate && tool.id === candidate.id && tool.name === candidate.name && tool.kind === candidate.kind
            && tool.status === candidate.status && tool.target === candidate.target && tool.detail === candidate.detail
            && tool.line === candidate.line && tool.endLine === candidate.endLine && tool.exitCode === candidate.exitCode);
        });
      }
      case 'files':
        return right.type === 'files' && left.files.length === right.files.length && left.files.every((file, fileIndex) => {
          const candidate = right.files[fileIndex];
          return Boolean(candidate && file.path === candidate.path && file.name === candidate.name && file.kind === candidate.kind
            && file.additions === candidate.additions && file.deletions === candidate.deletions
            && sameFileIcon(file.icon, candidate.icon)
            && file.preview?.length === candidate.preview?.length && (file.preview ?? []).every((line, lineIndex) => {
              const next = candidate.preview?.[lineIndex];
              return Boolean(next && line.kind === next.kind && line.line === next.line && line.text === next.text);
            }));
        });
      case 'todo':
        return right.type === 'todo' && left.items.length === right.items.length && left.items.every((item, itemIndex) => {
          const candidate = right.items[itemIndex];
          return Boolean(candidate && item.content === candidate.content && item.status === candidate.status);
        });
      case 'subagent':
        return right.type === 'subagent' && left.items.length === right.items.length && left.items.every((item, itemIndex) => {
          const candidate = right.items[itemIndex];
          return Boolean(candidate && item.id === candidate.id && item.agentId === candidate.agentId && item.model === candidate.model
            && item.name === candidate.name && item.task === candidate.task && item.status === candidate.status
            && item.background === candidate.background && item.durationMs === candidate.durationMs && item.resultPreview === candidate.resultPreview);
        });
    }
  });
}

function sameFileIcon(left: FileRow['icon'], right: FileRow['icon']): boolean {
  return left?.type === right?.type && left?.src === right?.src && left?.badge === right?.badge
    && left?.fontFamily === right?.fontFamily && left?.fontCharacter === right?.fontCharacter && left?.fontColor === right?.fontColor;
}

function previewLines(lines: readonly FileDiffLine[], expanded: boolean): readonly FileDiffLine[] {
  if (expanded || lines.length <= previewFoldLimit) return lines;
  const head = lines.slice(0, previewHeadLines);
  const marker = lines.slice(previewHeadLines).find((line) => line.kind === 'more');
  return marker ? [...head, marker] : head;
}

function fileLanguage(name: string): string {
  const parts = name.split(/[\\/]/);
  const base = parts[parts.length - 1]!;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'file';
  return base.slice(dot + 1).toLowerCase();
}

function workSummary(turn: TurnModel, _locale: Locale, copy: Copy): string {
  if (turn.status === 'unknown') return turn.log.length ? copy.turnUnknown : '';
  const running = turn.log.flatMap(segmentTools).find((tool) => tool.status === 'running');
  if (!turn.done) return running ? `${copy.working} · ${running.target || running.name}` : copy.working;
  const elapsed = workElapsedMs(turn);
  if (elapsed === undefined) return '';
  const base = `${copy.worked} ${formatDuration(elapsed)}`;
  return turn.status === 'cancelled' ? `${base} · ${copy.interrupted}` : base;
}

function thoughtLabel(text: string, duration: number | undefined, running: boolean, copy: Copy): string {
  const heading = thoughtHeading(text);
  const verb = running ? copy.thinking : (heading ?? copy.thought);
  if (duration === undefined) return verb;
  if (duration < 500) return running ? verb : copy.thoughtBriefly;
  return `${verb} ${formatDuration(duration)}`;
}

function thoughtHeading(text: string): string | undefined {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean);
  const match = line ? /^#{1,6}\s+(.+)$/.exec(line) : undefined;
  const title = match?.[1]?.trim();
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function exploreFailureLabel(label: string, locale: Locale, failed: boolean): string {
  if (!failed) return label;
  return locale === 'ja' ? label.replace(/を調べました$|を調べています$/, 'の調査に失敗しました').replace(/^調査中$|^調査$/, '調査に失敗しました') : `Failed ${label.replace(/^(Explored|Exploring)\s*/, '')}`;
}

function shellCaption(command: string, copy: Copy): string {
  const executable = command.trim().match(/^(?:[A-Za-z_][\w]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:sudo\s+)?(?:[^\s;&|]+\/)?([^\s;&|]+)/)?.[1];
  return executable ? `${copy.ran} ${executable}` : copy.ranCommand;
}

function activityLabel(tool: ToolRow, copy: Copy): string {
  if ((tool.kind === 'shell' || tool.kind === 'git') && tool.target) return shellCaption(tool.target, copy);
  if (tool.kind === 'read' && tool.target) {
    const range = tool.line ? ` L${tool.line}${tool.endLine && tool.endLine !== tool.line ? `-${tool.endLine}` : ''}` : '';
    return `${copy.readFile} ${basename(tool.target)}${range}`;
  }
  if (tool.kind === 'search') return `${copy.ran} ${tool.name}`;
  if (tool.kind === 'edit' && tool.target) return `${copy.edited} ${basename(tool.target)}`;
  return tool.name;
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.at(-1) || file;
}

function segmentTools(segment: Segment): ToolRow[] {
  return segment.type === 'tools' || segment.type === 'explore' || segment.type === 'ran' || segment.type === 'edited' ? segment.tools : [];
}

function shellOutput(detail: string, command: string): string {
  const newline = detail.indexOf('\n');
  const header = newline < 0 ? detail : detail.slice(0, newline);
  const hasStatusPrefix = /^(?:in[-_]?progress|running|completed|success|failed|error|cancelled|aborted):\s*.+$/i.test(header);
  const hasCommandHeader = header === command;
  if (newline < 0) return hasCommandHeader || hasStatusPrefix ? '' : detail;
  return hasCommandHeader || hasStatusPrefix ? detail.slice(newline + 1) : detail;
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

function shellUsage(shell: ViewShell | null, id: string) { return shell?.timings?.find((turn) => turn.id === id)?.usage; }
