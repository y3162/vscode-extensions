import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';

export class HistoryPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly dom: Dom, parent: HTMLElement, private readonly onSelect: (id: string) => void) {
    this.element = dom.el('section', 'home');
    this.list = dom.el('div', 'session-list');
    this.element.append(this.list);
    parent.append(this.element);
  }

  get hidden(): boolean { return this.element.hidden; }

  render(shell: ViewShell, copy: Copy): void {
    this.element.setAttribute('aria-label', copy.history);
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
      if (activity) card.append(this.dom.el('span', `presence ${activity}`));
      card.append(this.dom.el('span', 'session-name', title));
      card.addEventListener('click', () => this.onSelect(session.conversationId ?? session.id));
      this.list.append(card);
    }
  }
}
