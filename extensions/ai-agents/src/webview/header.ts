import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';

export type Page = 'home' | 'chat';

export class Header {
  private readonly homeBar: HTMLElement;
  private readonly chatBar: HTMLElement;
  private readonly provider: HTMLButtonElement;
  private readonly homeSettings: HTMLButtonElement;
  private readonly back: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly chatFresh: HTMLButtonElement;
  private readonly chatSettings: HTMLButtonElement;
  private readonly presence: HTMLElement;
  private readonly live: HTMLElement;
  private liveText = '';

  constructor(
    dom: Dom,
    root: HTMLElement,
    copy: Copy,
    private readonly onProvider: (anchor: HTMLElement) => void,
    private readonly onNewChat: () => void,
    private readonly onSettings: () => void,
    private readonly onBack: () => void,
  ) {
    this.homeBar = dom.el('div', 'top-bar home-bar');
    this.provider = dom.button('provider', copy.provider, 'chevron-down');
    this.provider.setAttribute('aria-haspopup', 'menu');
    this.provider.setAttribute('aria-expanded', 'false');
    this.provider.addEventListener('click', () => this.onProvider(this.provider));
    const actions = dom.el('div', 'home-actions');
    this.homeSettings = dom.button('icon-btn header-btn open-settings', copy.settings, 'settings-gear');
    this.homeSettings.addEventListener('click', () => this.onSettings());
    actions.append(this.homeSettings);
    this.homeBar.append(this.provider, actions);

    this.chatBar = dom.el('div', 'top-bar chat-bar');
    this.back = dom.button('back', copy.back, 'arrow-left');
    this.back.addEventListener('click', () => this.onBack());
    this.presence = dom.el('span', 'presence');
    this.presence.hidden = true;
    this.title = dom.el('h1', 'title-pill');
    const title = dom.el('div', 'chat-title');
    title.append(this.presence, this.title);
    this.chatSettings = dom.button('icon-btn header-btn open-settings', copy.settings, 'settings-gear');
    this.chatSettings.addEventListener('click', () => this.onSettings());
    const chatActions = dom.el('div', 'home-actions');
    this.chatFresh = dom.button('icon-btn header-btn new-chat', copy.newChat, 'add');
    this.chatFresh.addEventListener('click', () => this.onNewChat());
    chatActions.append(this.chatFresh, this.chatSettings);
    this.chatBar.append(this.back, title, chatActions);

    this.live = dom.el('span', 'live');
    this.live.setAttribute('aria-live', 'polite');
    root.append(this.homeBar, this.chatBar, this.live);
  }

  render(shell: ViewShell, copy: Copy, page: Page): void {
    this.homeBar.hidden = page !== 'home';
    this.chatBar.hidden = page !== 'chat';
    const providerName = shell.providers.find((item) => item.id === shell.provider)?.label
      ?? (shell.provider === 'cursor' ? 'Cursor' : 'Codex');
    this.caption(this.provider, providerName);
    this.provider.disabled = shell.busy;
    this.caption(this.chatFresh, copy.newChat);
    this.caption(this.homeSettings, copy.settings);
    this.caption(this.chatSettings, copy.settings);
    const active = shell.presence === 'running' || shell.presence === 'waiting' || shell.presence === 'error';
    this.presence.hidden = !active;
    this.presence.className = active ? `presence ${shell.presence}` : 'presence';
    this.presence.title = shell.statusText;
    this.caption(this.back, copy.back);
    this.title.textContent = shell.sessionTitle;
    this.title.title = shell.sessionTitle;
    if (this.liveText !== shell.statusText) {
      this.liveText = shell.statusText;
      this.live.textContent = shell.statusText;
    }
  }

  private caption(button: HTMLButtonElement, text: string): void {
    button.querySelector('.btn-label')!.textContent = text;
    button.title = text;
    button.setAttribute('aria-label', text);
  }
}
