import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import { relativeTime, type Copy } from './strings.js';
import type { Post } from './cards.js';

export class HistoryPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly dom: Dom, parent: HTMLElement, private readonly post: Post, private readonly onClose: () => void) {
    this.element = dom.el('section', 'panel');
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'History');
    const bar = dom.el('div', 'panel-bar');
    this.list = dom.el('div', 'session-list');
    this.element.append(bar, this.list);
    parent.append(this.element);
    this.bar = bar;
  }

  private readonly bar: HTMLElement;

  get hidden(): boolean { return this.element.hidden; }

  open(): void { this.element.hidden = false; }
  close(): void { this.element.hidden = true; }

  render(shell: ViewShell, copy: Copy): void {
    this.element.setAttribute('aria-label', copy.history);
    this.bar.replaceChildren();
    const title = this.dom.el('h2', undefined, copy.history);
    const close = this.dom.button('ghost', copy.close, 'close');
    close.addEventListener('click', () => this.onClose());
    const fresh = this.dom.button('ghost', copy.newChat, 'add');
    fresh.addEventListener('click', () => this.post({ type: 'newChat' }));
    this.bar.append(title, fresh, close);
    this.list.replaceChildren();
    const sessions = [...shell.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (!sessions.length) this.list.append(this.dom.el('p', 'empty-copy', copy.noSessions));
    for (const session of sessions) {
      const row = this.dom.el('button', 'session-row');
      row.type = 'button';
      if (session.id === shell.sessionId) row.classList.add('current');
      if (shell.busy && session.id === shell.sessionId) row.append(this.dom.el('span', 'presence running'));
      const name = this.dom.el('span', 'session-name', session.title || session.id);
      const time = this.dom.el('span', 'session-time', relativeTime(shell.locale, session.updatedAt));
      row.append(name, time);
      row.addEventListener('click', () => this.post({ type: 'restoreSession', id: session.id }));
      this.list.append(row);
    }
  }
}
