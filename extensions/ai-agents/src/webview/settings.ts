import { isElement, type Dom } from './dom.js';
import type { ViewChoice, ViewShell } from '../protocol.js';
import type { Copy } from './strings.js';
import type { Post } from './cards.js';

export class SettingsPanel {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly inspectorTitle: HTMLElement;
  private readonly inspectorBody: HTMLElement;
  private applying = false;
  private signature = '';
  private returnFocus: HTMLElement | null = null;
  private shell: ViewShell | null = null;

  constructor(private readonly dom: Dom, parent: HTMLElement, private readonly post: Post, private readonly onClose: () => void) {
    this.element = dom.el('section', 'panel settings-panel');
    this.element.hidden = true;
    this.body = dom.el('div', 'settings-body');
    this.inspector = dom.el('section', 'inspector');
    this.inspector.hidden = true;
    this.inspectorTitle = dom.el('h3');
    this.inspectorBody = dom.el('pre');
    this.inspector.append(this.inspectorTitle, this.inspectorBody);
    this.element.append(this.body, this.inspector);
    parent.append(this.element);
  }

  get hidden(): boolean { return this.element.hidden; }
  open(): void {
    if (this.element.hidden) {
      const active = this.dom.document.activeElement;
      this.returnFocus = isElement(active) ? active : null;
    }
    this.element.hidden = false;
    this.body.querySelector<HTMLButtonElement>('button')?.focus();
  }
  close(): void {
    this.element.hidden = true;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  showInspector(title: string, text: string): void {
    this.inspector.hidden = false;
    this.inspectorTitle.textContent = title;
    this.inspectorBody.textContent = text;
    this.open();
  }

  render(shell: ViewShell, copy: Copy): void {
    this.shell = shell;
    const signature = JSON.stringify([shell.locale, shell.busy, shell.backendChoices, shell.backend, shell.sandboxChoices, shell.sandbox, shell.showApproval, shell.approvalChoices, shell.approval, shell.showWebSearch, shell.webSearchChoices, shell.webSearch, shell.showNetwork, shell.network, shell.additionalDirectories, shell.autoApprove]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.applying = true;
    this.body.replaceChildren();
    const bar = this.dom.el('div', 'panel-bar');
    bar.append(this.dom.el('h2', undefined, copy.settings));
    const close = this.dom.button('ghost', copy.close, 'close');
    close.addEventListener('click', () => this.onClose());
    bar.append(close);
    this.body.append(bar);
    this.body.append(this.dom.el('h3', 'section-label', copy.executionSettings));
    this.body.append(this.select(copy.backend, 'backend', shell.backendChoices, shell.backend));
    this.body.append(this.select(copy.access, 'sandbox', shell.sandboxChoices, shell.sandbox));
    if (shell.showApproval) this.body.append(this.select(copy.approvalPolicy, 'approval', shell.approvalChoices, shell.approval));
    if (shell.showWebSearch) this.body.append(this.select(copy.webSearch, 'webSearch', shell.webSearchChoices, shell.webSearch));
    if (shell.showNetwork) this.body.append(this.check(copy.network, shell.network));
    if (shell.additionalDirectories.length) {
      const group = this.dom.el('div', 'dir-list');
      group.append(this.dom.el('h3', undefined, copy.directories));
      for (const folder of shell.additionalDirectories) {
        const row = this.dom.el('div', 'dir-row');
        row.append(this.dom.el('span', undefined, folder));
        const remove = this.dom.button('ghost', copy.remove, 'close');
        remove.addEventListener('click', () => this.post({ type: 'removeDirectory', path: folder }));
        row.append(remove);
        group.append(row);
      }
      this.body.append(group);
    }
    const auto = this.dom.button(shell.autoApprove ? 'secondary pressed' : 'secondary', copy.autoApprove);
    auto.setAttribute('aria-pressed', String(shell.autoApprove));
    auto.addEventListener('click', () => this.post({ type: 'toggleAutoApprove' }));
    this.body.append(auto);
    this.body.append(this.dom.el('p', 'menu-note', copy.sandboxNote));
    const tools = this.dom.el('div', 'tool-row');
    tools.setAttribute('aria-label', copy.accountTools);
    for (const [label, type] of [
      [copy.signIn, 'login'], [copy.apiKey, 'apiKey'], [copy.diagnose, 'diagnose'],
      [copy.usage, 'usage'], [copy.rules, 'instructions'], [copy.logs, 'logs'], [copy.vscodeSettings, 'settings'],
    ] as const) {
      const button = this.dom.button('ghost', label);
      button.addEventListener('click', () => this.post({ type }));
      tools.append(button);
    }
    this.body.append(tools);
    this.applying = false;
  }

  private select(label: string, key: string, choices: ViewChoice[], selected: string): HTMLLabelElement {
    const wrap = this.dom.el('label', 'field');
    wrap.append(label);
    const select = this.dom.el('select');
    select.dataset.key = key;
    for (const option of choices) {
      const item = this.dom.el('option', undefined, option.label);
      item.value = option.id;
      if (option.description) item.title = option.description;
      select.append(item);
    }
    select.value = selected;
    select.disabled = Boolean(this.shell?.busy);
    select.addEventListener('change', () => this.changed(key, select.value));
    wrap.append(select);
    return wrap;
  }

  private check(label: string, checked: boolean): HTMLLabelElement {
    const wrap = this.dom.el('label', 'field check');
    const input = this.dom.el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = Boolean(this.shell?.busy);
    input.addEventListener('change', () => this.changed('network', input.checked));
    wrap.append(input, label);
    return wrap;
  }

  private changed(key: string, value: string | boolean): void {
    if (this.applying || !this.shell) return;
    this.post({
      type: 'configure',
      mode: this.shell.mode,
      sandbox: this.shell.sandbox,
      approval: this.shell.approval,
      backend: this.shell.backend,
      network: this.shell.network,
      webSearch: this.shell.webSearch,
      [key]: value,
    });
  }
}
