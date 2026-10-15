import type { Dom } from './dom.js';
import type { ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';

export class Header {
  private readonly provider: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly live: HTMLElement;
  private liveText = '';

  constructor(dom: Dom, root: HTMLElement, copy: Copy, private readonly onProvider: (anchor: HTMLElement) => void) {
    const bar = dom.el('div', 'top-bar');
    this.provider = dom.button('provider', copy.provider, 'chevron-down');
    this.provider.setAttribute('aria-haspopup', 'menu');
    this.provider.setAttribute('aria-expanded', 'false');
    this.provider.addEventListener('click', () => this.onProvider(this.provider));
    this.title = dom.el('h1', 'session-title');
    this.dot = dom.el('span', 'presence');
    this.live = dom.el('span', 'live');
    this.live.setAttribute('aria-live', 'polite');
    bar.append(this.provider, this.title, this.dot, this.live);
    root.append(bar);
  }

  render(shell: ViewShell, copy: Copy): void {
    const label = this.provider.querySelector('.btn-label');
    if (label) label.textContent = shell.providerLabel;
    this.provider.title = copy.provider;
    this.provider.setAttribute('aria-label', shell.providerLabel);
    this.provider.disabled = shell.busy;
    this.title.textContent = shell.sessionTitle;
    this.dot.className = `presence ${shell.presence}`;
    this.dot.title = shell.statusText;
    if (this.liveText !== shell.statusText) {
      this.liveText = shell.statusText;
      this.live.textContent = shell.statusText;
    }
  }
}
