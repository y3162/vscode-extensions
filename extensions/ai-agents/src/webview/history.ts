import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import { relativeTime, type Copy } from './strings.js';

export class HistoryPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly start: HTMLButtonElement;

  constructor(private readonly dom: Dom, parent: HTMLElement, private readonly onSelect: (id: string) => void, onNew?: () => void) {
    this.element = dom.el('section', 'home');
    this.heading = dom.el('h2', 'home-heading');
    this.start = dom.button('primary home-start new-chat', '', 'add');
    this.start.addEventListener('click', () => onNew?.());
    this.start.hidden = !onNew;
    this.list = dom.el('div', 'session-list');
    this.element.append(this.start, this.heading, this.list);
    parent.append(this.element);
  }

  get hidden(): boolean { return this.element.hidden; }

  render(shell: ViewShell, copy: Copy): void {
    this.element.setAttribute('aria-label', copy.history);
    this.heading.textContent = copy.recentChats;
    this.start.querySelector('.btn-label')!.textContent = copy.newChat;
    this.start.setAttribute('aria-label', copy.newChat);
    this.start.title = copy.newChat;
    this.list.replaceChildren();
    const sessions = [...shell.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (!sessions.length) {
      this.list.append(this.dom.el('p', 'empty-home', copy.noSessions));
      return;
    }
    for (const session of sessions) {
      const title = session.title || session.id;
      const card = this.dom.el('button', 'session-card');
      card.type = 'button';
      card.dataset.sessionId = session.id;
      card.title = title;
      card.setAttribute('aria-label', title);
      if (session.id === shell.sessionId) card.setAttribute('aria-current', 'true');
      const activity = session.activity && session.activity !== 'idle' ? session.activity : session.id === shell.sessionId && (shell.presence === 'running' || shell.presence === 'waiting') ? shell.presence : '';
      const body = this.dom.el('span', 'session-copy');
      body.append(this.dom.el('span', 'session-name', title));
      const meta = this.dom.el('span', 'session-meta');
      if (activity) {
        const mark = this.dom.el('span', `presence ${activity}`);
        mark.setAttribute('aria-hidden', 'true');
        const status = activity === 'running' ? copy.subagentRunning : activity === 'waiting' ? copy.waiting : copy.subagentFailed;
        meta.append(mark, this.dom.el('span', undefined, status));
        card.setAttribute('aria-label', `${title} · ${status}`);
      }
      const time = this.dom.el('time', 'session-time', relativeTime(shell.locale, session.updatedAt));
      time.dateTime = session.updatedAt;
      time.title = session.updatedAt;
      meta.append(time);
      body.append(meta);
      card.append(body);
      card.addEventListener('click', () => this.onSelect(session.conversationId ?? session.id));
      this.list.append(card);
    }
  }
}
