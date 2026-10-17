import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';

export type Page = 'home' | 'chat';

export class Header {
  private readonly homeBar: HTMLElement;
  private readonly chatBar: HTMLElement;
  private readonly provider: HTMLButtonElement;
  private readonly fresh: HTMLButtonElement;
  private readonly homeSettings: HTMLButtonElement;
  private readonly back: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly chatSettings: HTMLButtonElement;
  private readonly live: HTMLElement;
  private readonly terminals: HTMLButtonElement;
  private liveText = '';

  constructor(
    dom: Dom,
    root: HTMLElement,
    copy: Copy,
    private readonly onProvider: (anchor: HTMLElement) => void,
    private readonly onNewChat: () => void,
    private readonly onSettings: () => void,
    private readonly onBack: () => void,
    private readonly onTerminals: (anchor: HTMLElement) => void,
  ) {
    this.homeBar = dom.el('div', 'top-bar home-bar');
    this.provider = dom.button('provider', copy.provider, 'chevron-down');
    this.provider.setAttribute('aria-haspopup', 'menu');
    this.provider.setAttribute('aria-expanded', 'false');
    this.provider.addEventListener('click', () => this.onProvider(this.provider));
    const actions = dom.el('div', 'home-actions');
    this.fresh = dom.button('icon-btn header-btn new-chat', copy.newChat, 'edit');
    this.fresh.addEventListener('click', () => this.onNewChat());
    this.homeSettings = dom.button('icon-btn header-btn open-settings', copy.settings, 'settings-gear');
    this.homeSettings.addEventListener('click', () => this.onSettings());
    actions.append(this.fresh, this.homeSettings);
    this.homeBar.append(this.provider, actions);

    this.chatBar = dom.el('div', 'top-bar chat-bar');
    this.back = dom.button('back', copy.back, 'arrow-left');
    this.back.addEventListener('click', () => this.onBack());
    this.title = dom.el('h1', 'title-pill');
    this.chatSettings = dom.button('icon-btn header-btn open-settings', copy.settings, 'settings-gear');
    this.chatSettings.addEventListener('click', () => this.onSettings());
    const chatActions = dom.el('div', 'home-actions');
    this.terminals = dom.button('icon-btn header-btn open-terminals', copy.backgroundTerminals, 'terminal');
    this.terminals.addEventListener('click', () => this.onTerminals(this.terminals));
    chatActions.append(this.terminals, this.chatSettings);
    this.chatBar.append(this.back, this.title, chatActions);

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
    this.caption(this.fresh, copy.newChat);
    this.caption(this.homeSettings, copy.settings);
    this.caption(this.chatSettings, copy.settings);
    this.terminals.hidden = !shell.terminals.length;
    this.caption(this.terminals, `${shell.terminals.length} ${copy.backgroundTerminals}`);
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
