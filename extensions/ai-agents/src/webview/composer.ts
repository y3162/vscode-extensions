import { isToggleOn, orderedParameters, toggleOnValue } from '../model-settings.js';
import type { ModelCatalogMessage, ViewChange, ViewShell } from '../protocol.js';
import type { ModelParameter } from '../types.js';
import type { Post } from './cards.js';
import type { Dom } from './dom.js';
import { ModelMenu, type Menu, type ModelMenuItem, type ModelMenuPage } from './popover.js';
import type { Copy } from './strings.js';

interface Chip { label: string; text: string }
interface ImageChip { mimeType: string; data: string; name?: string }
interface CaretToken { kind: 'file' | 'slash'; query: string; start: number }

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class Composer {
  private readonly input: HTMLTextAreaElement;
  private readonly chips: Chip[] = [];
  private readonly images: ImageChip[] = [];
  private readonly chipRow: HTMLElement;
  private readonly queueRow: HTMLElement;
  private readonly suggest: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly changes: HTMLElement;
  private readonly mode: HTMLButtonElement;
  private readonly model: HTMLButtonElement;
  private readonly send: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly env: HTMLButtonElement;
  private readonly modelMenu: ModelMenu;
  private shell: ViewShell | null = null;
  private copy: Copy | null = null;
  private catalog: ModelCatalogMessage | null = null;
  private catalogRequest = 0;
  private seenIdentity = '';
  private buildMenu = false;
  private composing = false;
  private suggestRequest = 0;
  private suggestItems: { label: string; description?: string; token: string }[] = [];
  private suggestIndex = 0;
  private suggestToken: CaretToken | undefined;
  private historyPrompt = '';
  private timer = 0;

  constructor(
    private readonly dom: Dom,
    parent: HTMLElement,
    private readonly post: Post,
    private readonly menu: Menu,
    private readonly onNavigate: (panel: 'settings' | 'history' | 'chat') => void,
  ) {
    this.banner = dom.el('div', 'banner');
    this.banner.hidden = true;
    this.changes = dom.el('div', 'change-bar');
    this.changes.hidden = true;
    const form = dom.el('form', 'composer-card');
    this.chipRow = dom.el('div', 'chips');
    this.queueRow = dom.el('div', 'queue');
    this.suggest = dom.el('div', 'suggest');
    this.suggest.hidden = true;
    this.suggest.role = 'listbox';
    this.input = dom.el('textarea');
    this.input.rows = 1;
    this.input.maxLength = 100000;
    this.input.required = false;
    const label = dom.el('label', 'sr-only', 'Prompt');
    label.htmlFor = 'prompt';
    this.input.id = 'prompt';
    const row = dom.el('div', 'composer-row');
    const left = dom.el('div', 'row-left');
    this.mode = dom.button('pill mode', 'Mode', 'chevron-down');
    this.mode.setAttribute('aria-haspopup', 'menu');
    this.mode.addEventListener('click', () => this.openMode());
    this.model = dom.button('pill model-name', 'Model', 'chevron-down');
    this.model.addEventListener('click', () => this.openModel());
    left.append(this.mode, this.model);
    const right = dom.el('div', 'row-right');
    this.attach = dom.button('icon-btn attach', 'Attach', 'attach');
    this.attach.addEventListener('click', () => this.openAttach(this.attach));
    this.stop = dom.button('icon-btn stop', 'Stop', 'debug-stop');
    this.stop.hidden = true;
    this.stop.addEventListener('click', () => this.post({ type: 'stop' }));
    this.send = dom.button('send', 'Send', 'arrow-up');
    this.send.addEventListener('click', () => this.submit());
    right.append(this.attach, this.stop, this.send);
    row.append(left, right);
    form.append(this.chipRow, this.queueRow, this.suggest, label, this.input, row);
    this.env = dom.button('env', 'Local', 'vm');
    this.env.addEventListener('click', () => this.openEnvironment());
    const file = dom.el('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/gif,image/webp';
    file.multiple = true;
    file.hidden = true;
    file.addEventListener('change', () => { this.addImages(file.files); file.value = ''; });
    parent.append(this.banner, this.changes, form, this.env, file);
    this.modelMenu = new ModelMenu(dom, menu.element.parentElement ?? parent);
    this.fileInput = file;
    form.addEventListener('submit', (event) => event.preventDefault());
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.addEventListener('input', () => { this.resize(); this.queueSuggest(); });
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    this.input.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((item) => item.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      this.addImages(files);
    });
  }

  private readonly fileInput: HTMLInputElement;
  private readonly attach: HTMLButtonElement;

  get draft(): string { return this.input.value; }
  set draft(value: string) { this.input.value = value; this.resize(); }
  focus(): void { this.input.focus(); }
  closeMenus(): void { this.menu.close(false); this.modelMenu.close(false); }

  setCatalog(message: ModelCatalogMessage): void {
    const shell = this.shell;
    if (!shell || message.requestId !== this.catalogRequest || message.provider !== shell.provider || message.cwd !== shell.cwd) return;
    this.catalog = message;
    if (this.modelMenu.isOpen) this.modelMenu.replace(this.modelPage());
  }
  onInput(handler: () => void): void { this.input.addEventListener('input', handler); }

  notePrompt(text: string): void { if (text) this.historyPrompt = text; }

  insert(text: string, label?: string): void {
    const gap = this.input.value && !this.input.value.endsWith('\n') ? '\n' : '';
    this.input.value += `${gap}${text}`;
    if (label) this.chips.push({ label, text });
    this.renderChips();
    this.resize();
    this.input.focus();
  }

  setSuggestions(requestId: number, items: { label: string; description?: string; token: string }[]): void {
    if (requestId !== this.suggestRequest) return;
    this.suggestItems = items;
    this.suggestIndex = 0;
    this.suggest.replaceChildren();
    this.suggest.hidden = !items.length;
    items.forEach((item, index) => {
      const button = this.dom.el('button', index === 0 ? 'suggest-item active' : 'suggest-item');
      button.type = 'button';
      button.role = 'option';
      button.id = `suggest-${index}`;
      button.append(this.dom.el('span', undefined, item.label));
      if (item.description) button.append(this.dom.el('small', undefined, item.description));
      button.addEventListener('mousedown', (event) => { event.preventDefault(); this.applySuggestion(item); });
      this.suggest.append(button);
    });
    this.input.setAttribute('aria-expanded', String(!this.suggest.hidden));
    if (items.length) this.input.setAttribute('aria-activedescendant', 'suggest-0');
    else this.input.removeAttribute('aria-activedescendant');
  }

  render(shell: ViewShell, copy: Copy): void {
    this.shell = shell;
    this.copy = copy;
    const revising = shell.mode === 'plan' && (shell.planView?.phase === 'ready' || shell.planView?.phase === 'revising');
    this.input.placeholder = revising ? copy.revisePlaceholder : copy.placeholder;
    this.input.setAttribute('aria-label', copy.placeholder);
    this.togglePill(this.mode, shell.showMode, shell.modes.find((mode) => mode.id === shell.mode)?.label ?? shell.mode, copy.mode);
    if (this.catalog && (this.catalog.provider !== shell.provider || this.catalog.cwd !== shell.cwd)) this.catalog = null;
    const modelText = shell.effortLabel ? `${shell.modelLabel} ${shell.effortLabel}` : shell.modelLabel;
    const modelLabel = this.model.querySelector('.btn-label');
    if (modelLabel) modelLabel.textContent = modelText;
    this.model.title = modelText;
    this.model.setAttribute('aria-label', modelText);
    const adjustable = shell.modelSettings !== 'unsupported';
    this.model.classList.toggle('is-static', !adjustable);
    this.model.setAttribute('aria-haspopup', adjustable ? 'menu' : 'false');
    this.model.disabled = shell.busy;
    const identity = `${shell.provider}\0${shell.cwd}\0${shell.sessionId ?? ''}\0${shell.backend}`;
    if (this.seenIdentity && this.seenIdentity !== identity) this.modelMenu.close(false);
    this.seenIdentity = identity;
    if ((shell.busy || !adjustable) && this.modelMenu.isOpen) this.modelMenu.close(false);
    this.attach.title = copy.attach;
    this.attach.setAttribute('aria-label', copy.attach);
    this.mode.disabled = shell.busy;
    this.send.disabled = !shell.cwd;
    const sendLabel = this.send.querySelector('.btn-label');
    if (sendLabel) sendLabel.textContent = shell.busy ? copy.queue : copy.send;
    this.send.title = shell.busy ? copy.queue : copy.send;
    this.send.setAttribute('aria-label', shell.busy ? copy.queue : copy.send);
    this.stop.hidden = !shell.busy;
    this.stop.title = copy.stop;
    this.stop.setAttribute('aria-label', copy.stop);
    const envText = `${copy.local} · ${shell.folderName} · ${shell.backendLabel}`;
    const envLabel = this.env.querySelector('.btn-label');
    if (envLabel) envLabel.textContent = envText;
    this.env.title = envText;
    this.env.setAttribute('aria-label', envText);
    this.renderBanner(shell, copy);
    this.renderChanges(shell, copy);
    this.renderQueue(shell, copy);
  }

  private togglePill(button: HTMLButtonElement, show: boolean, label: string, title: string): void {
    button.hidden = !show;
    const caption = button.querySelector('.btn-label');
    if (caption) caption.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', label);
  }

  private renderBanner(shell: ViewShell, copy: Copy): void {
    const banner = shell.banner;
    this.banner.hidden = !banner;
    this.banner.replaceChildren();
    if (!banner) return;
    this.banner.append(this.dom.icon('warning'), this.dom.el('div', 'banner-copy'));
    const text = this.banner.querySelector('.banner-copy');
    text?.append(this.dom.el('strong', undefined, banner.title), this.dom.el('p', undefined, banner.body));
    const hide = this.dom.button('ghost', copy.dontShow);
    hide.addEventListener('click', () => this.post({ type: 'dismissWarning', id: banner.id }));
    const close = this.dom.button('icon-btn', copy.dismiss, 'close');
    close.addEventListener('click', () => this.post({ type: 'dismissWarning', id: banner.id }));
    this.banner.append(hide, close);
  }

  private renderChanges(shell: ViewShell, copy: Copy): void {
    const count = shell.changes.length;
    const terminals = shell.terminals ?? [];
    this.changes.hidden = !count && !terminals.length && !shell.terminalError;
    if (shell.terminalError) this.changes.append(this.dom.el('p', 'error-block', `${copy.backgroundTerminals}: ${shell.terminalError}`));
    this.changes.replaceChildren();
    if (count) {
      const head = this.dom.el('div', 'change-head');
      const stats = `${shell.additions || shell.deletions ? ` +${shell.additions} −${shell.deletions}` : ''}`;
      head.append(this.dom.el('span', undefined, `${count} ${copy.files}${stats}`));
      const review = this.dom.button('ghost', copy.review);
      review.addEventListener('click', () => this.post({ type: 'reviewChanges' }));
      head.append(review);
      this.changes.append(head);
      for (const change of shell.changes) this.changes.append(this.changeRow(change, copy));
    }
    if (terminals.length) {
      const list = this.dom.el('div', 'terminals');
      list.append(this.dom.el('p', 'subagent-label', copy.backgroundTerminals));
      for (const terminal of terminals) {
        const row = this.dom.el('div', 'terminal-row');
        const label = terminal.status ? `${terminal.command || terminal.processId} · ${terminal.status}` : terminal.command || terminal.processId;
        row.append(this.dom.el('span', undefined, label));
        const stop = this.dom.button('ghost tiny', copy.terminate);
        stop.addEventListener('click', () => this.post({ type: 'terminateTerminal', processId: terminal.processId }));
        row.append(stop);
        if (terminal.error) row.append(this.dom.el('p', 'terminal-detail error-block', terminal.error));
        if (terminal.output) row.append(this.dom.el('pre', 'terminal-detail', terminal.output));
        list.append(row);
      }
      this.changes.append(list);
    }
  }

  private changeRow(change: ViewChange, copy: Copy): HTMLElement {
    const row = this.dom.el('div', 'change-file');
    row.append(fileIcon(this.dom, change));
    const open = this.dom.el('button', 'file-link', change.name);
    open.type = 'button';
    open.addEventListener('click', () => this.post({ type: change.canDiff ? 'openDiff' : 'openFile', path: change.path }));
    const counts = this.dom.el('span', 'stats');
    if (change.additions !== undefined) counts.append(this.dom.el('span', 'add', `+${change.additions}`));
    if (change.deletions !== undefined) counts.append(this.dom.el('span', 'del', `−${change.deletions}`));
    row.append(open, counts);
    if (change.canRevert) {
      const revert = this.dom.button('ghost tiny', copy.revert);
      revert.addEventListener('click', () => this.post({ type: 'revertFile', path: change.path }));
      row.append(revert);
    }
    return row;
  }

  openBuildModel(anchor: HTMLElement): void {
    const shell = this.shell;
    if (!shell || shell.modelSettings === 'unsupported' || !shell.planView?.showBuildModel) return;
    this.menu.close(false);
    this.buildMenu = true;
    this.requestCatalog(false);
    this.modelMenu.open(anchor, this.modelPage());
  }

  private renderQueue(shell: ViewShell, copy: Copy): void {
    this.queueRow.replaceChildren();
    for (const item of shell.queue) {
      const row = this.dom.el('div', 'queue-item');
      row.append(this.dom.el('span', undefined, item.text));
      const now = this.dom.button('secondary tiny', copy.sendNow);
      now.addEventListener('click', () => this.post({ type: 'sendNow', id: item.id }));
      const remove = this.dom.button('icon-btn', copy.remove, 'close');
      remove.addEventListener('click', () => this.post({ type: 'removeQueued', id: item.id }));
      row.append(now, remove);
      if (shell.steer && shell.busy) {
        const steer = this.dom.button('secondary tiny', copy.steer);
        steer.addEventListener('click', () => this.post({ type: 'steer', id: item.id }));
        row.append(steer);
      }
      this.queueRow.append(row);
    }
  }

  private renderChips(): void {
    this.chipRow.replaceChildren();
    this.chips.forEach((chip, index) => {
      const row = this.dom.el('span', 'chip');
      row.append(chip.label);
      const remove = this.dom.button('icon-btn', 'x', 'close');
      remove.addEventListener('click', () => {
        const text = this.chips[index]?.text ?? '';
        this.chips.splice(index, 1);
        const at = this.input.value.indexOf(text);
        if (at >= 0) this.input.value = `${this.input.value.slice(0, at)}${this.input.value.slice(at + text.length)}`;
        this.renderChips();
      });
      row.append(remove);
      this.chipRow.append(row);
    });
    this.images.forEach((image, index) => {
      const row = this.dom.el('span', 'chip');
      const preview = this.dom.el('img', 'thumb');
      preview.alt = image.name || 'image';
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      const remove = this.dom.button('icon-btn', 'x', 'close');
      remove.addEventListener('click', () => { this.images.splice(index, 1); this.renderChips(); });
      row.append(preview, remove);
      this.chipRow.append(row);
    });
  }

  private submit(): void {
    if (!this.shell?.cwd) return;
    const prompt = this.input.value;
    if (!prompt.trim() && !this.images.length) return;
    const attachments = [...this.chips.map((chip) => chip.label), ...this.images.map((image) => image.name || 'image')];
    this.post({
      type: this.shell.busy ? 'enqueue' : 'send', prompt, images: this.images.map((image) => ({ ...image })),
      ...(attachments.length ? { attachments } : {}),
    });
    if (prompt.trim()) this.historyPrompt = prompt;
    this.input.value = '';
    this.images.length = 0;
    this.chips.length = 0;
    this.suggest.hidden = true;
    this.renderChips();
    this.resize();
  }

  private onKey(event: KeyboardEvent): void {
    if (this.composing || event.isComposing || event.keyCode === 229) return;
    if (!this.suggest.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab' || event.key === 'Escape')) {
      event.preventDefault();
      if (event.key === 'Escape') { this.suggest.hidden = true; return; }
      if (event.key === 'Tab') { this.applySuggestion(this.suggestItems[this.suggestIndex]); return; }
      this.suggestIndex = event.key === 'ArrowUp'
        ? Math.max(0, this.suggestIndex - 1)
        : Math.min(this.suggestItems.length - 1, this.suggestIndex + 1);
      [...this.suggest.children].forEach((node, index) => node.classList.toggle('active', index === this.suggestIndex));
      this.input.setAttribute('aria-activedescendant', `suggest-${this.suggestIndex}`);
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && this.input.selectionStart === 0 && this.input.selectionEnd === 0 && !this.input.value && this.historyPrompt) {
      event.preventDefault();
      this.input.value = this.historyPrompt;
      this.resize();
      return;
    }
  }

  private queueSuggest(): void {
    const token = caretToken(this.input.value, this.input.selectionStart ?? 0);
    this.suggestToken = token;
    const view = this.dom.document.defaultView;
    view?.clearTimeout(this.timer);
    if (!token) { this.suggest.hidden = true; this.input.setAttribute('aria-expanded', 'false'); return; }
    const requestId = ++this.suggestRequest;
    this.timer = view?.setTimeout(() => {
      if (requestId !== this.suggestRequest) return;
      this.post({ type: 'suggest', kind: token.kind, query: token.query, requestId });
    }, 120) ?? 0;
  }

  private applySuggestion(item: { token: string } | undefined): void {
    if (!item || !this.suggestToken) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const insert = this.suggestToken.kind === 'file'
      ? `@${item.token.includes(' ') ? `"${item.token}"` : item.token} `
      : `/${item.token} `;
    this.input.value = `${this.input.value.slice(0, this.suggestToken.start)}${insert}${this.input.value.slice(caret)}`;
    this.suggest.hidden = true;
    this.input.focus();
  }

  private resize(): void {
    const view = this.dom.document.defaultView;
    const max = Math.max(80, (view?.innerHeight ?? 800) * 0.4);
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, max)}px`;
  }

  private addImages(files: FileList | File[] | null): void {
    for (const file of [...(files ?? [])]) {
      if (!imageTypes.has(file.type === 'image/jpg' ? 'image/jpeg' : file.type) || file.size > 5_000_000 || this.images.length >= 4) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const source = String(reader.result || '');
        this.images.push({ mimeType: file.type === 'image/jpg' ? 'image/jpeg' : file.type, data: source.slice(source.indexOf(',') + 1), name: file.name });
        this.renderChips();
      };
      reader.readAsDataURL(file);
    }
  }

  private openAttach(anchor: HTMLElement): void {
    const copy = this.copy;
    if (!copy) return;
    this.modelMenu.close(false);
    this.menu.open(anchor, [
      { id: 'image', label: copy.image, onSelect: () => this.fileInput.click() },
      { id: 'file', label: copy.file, onSelect: () => this.post({ type: 'attach', kind: 'file' }) },
      { id: 'selection', label: copy.selection, onSelect: () => this.post({ type: 'attach', kind: 'selection' }) },
      { id: 'problems', label: copy.problems, onSelect: () => this.post({ type: 'attach', kind: 'problems' }) },
      { id: 'git', label: copy.git, onSelect: () => this.post({ type: 'attach', kind: 'git' }) },
      { id: 'terminal', label: copy.terminal, onSelect: () => this.post({ type: 'attach', kind: 'terminal' }) },
    ]);
  }

  private openMode(): void {
    const shell = this.shell;
    if (!shell) return;
    this.modelMenu.close(false);
    const icons: Record<string, string> = { agent: 'infinity', plan: 'list-flat', ask: 'comment' };
    this.menu.open(this.mode, shell.modes.map((mode) => ({
      id: mode.id, label: mode.label, description: mode.description, icon: icons[mode.id],
      checked: mode.id === shell.mode,
      onSelect: () => this.configure({ mode: mode.id }),
    })));
  }

  private openModel(): void {
    const shell = this.shell;
    if (!shell || shell.busy || shell.modelSettings === 'unsupported') return;
    this.menu.close(false);
    this.buildMenu = false;
    this.requestCatalog(false);
    this.modelMenu.open(this.model, this.modelPage());
  }

  private requestCatalog(refresh: boolean): void {
    const shell = this.shell;
    if (!shell || shell.modelSettings === 'unsupported') return;
    this.catalogRequest += 1;
    this.post({ type: 'loadModelCatalog', requestId: this.catalogRequest, refresh });
  }

  private currentCatalog(): ModelCatalogMessage | null {
    const shell = this.shell;
    if (!shell || !this.catalog || this.catalog.provider !== shell.provider || this.catalog.cwd !== shell.cwd) return null;
    return this.catalog;
  }

  private modelPage(): ModelMenuPage {
    const shell = this.shell;
    const copy = this.copy;
    if (!shell || !copy) return { items: [] };
    const catalog = this.currentCatalog();
    if (!catalog) return { items: [{ id: 'status', label: copy.loadingModels }] };
    if (catalog.status === 'error') {
      return {
        items: [
          { id: 'status', label: catalog.error || copy.modelCatalogError },
          { id: 'refresh', label: copy.refreshModels, pinned: true, onSelect: () => this.requestCatalog(true) },
        ],
      };
    }
    const selectedId = this.buildMenu && shell.planView ? shell.planView.buildModelId : catalog.selectedModelId;
    const selected = catalog.models.find((model) => model.id === selectedId || model.aliases?.includes(selectedId));
    const items: ModelMenuItem[] = orderedParameters(selected?.parameters).flatMap((parameter) => this.parameterItem(parameter, catalog));
    items.push({
      id: 'model', label: copy.model, valueLabel: selected?.label || shell.modelLabel,
      separatorBefore: items.length > 0,
      submenu: () => this.modelListPage(catalog),
    });
    return { items };
  }

  private parameterItem(parameter: ModelParameter, catalog: ModelCatalogMessage): ModelMenuItem[] {
    const selectedParams = this.buildMenu && this.shell?.planView ? this.shell.planView.buildParams : catalog.selectedParams;
    const current = selectedParams.find((param) => param.id === parameter.id)?.value ?? parameter.defaultValue;
    const currentValue = parameter.values.find((value) => value.value === current);
    if (parameter.presentation === 'toggle') {
      const onValue = toggleOnValue(parameter.values);
      const offValue = parameter.values.find((value) => value.value !== onValue)?.value;
      if (!onValue || !offValue) return [];
      const on = isToggleOn(current);
      return [{
        id: parameter.id, label: parameter.label, toggle: true, checked: on,
        onSelect: () => this.post({ type: this.buildMenu ? 'setBuildParam' : 'setModelParam', id: parameter.id, value: on ? offValue : onValue }),
      }];
    }
    return [{
      id: parameter.id, label: parameter.label, valueLabel: currentValue?.label ?? current ?? '',
      description: currentValue?.description,
      submenu: () => ({
        backLabel: this.copy?.back,
        items: parameter.values.map((value) => ({
          id: `${parameter.id}:${value.value}`, label: value.label, description: value.description,
          checked: value.value === current,
          onSelect: () => this.post({ type: this.buildMenu ? 'setBuildParam' : 'setModelParam', id: parameter.id, value: value.value }),
        })),
      }),
    }];
  }

  private modelListPage(catalog: ModelCatalogMessage): ModelMenuPage {
    const copy = this.copy;
    const models = [
      { id: '', label: copy?.defaultModel ?? 'Default model', description: undefined, aliases: [] as string[] },
      ...catalog.models,
    ];
    return {
      backLabel: copy?.back,
      search: { placeholder: copy?.searchModels ?? 'Search models', empty: copy?.noModels ?? 'No matching models' },
      items: [
        ...models.map((model) => ({
          id: model.id ? `model:${model.id}` : 'model:default',
          label: model.label,
          description: model.description,
          searchText: [model.id, ...(model.aliases ?? [])].filter(Boolean).join(' '),
          checked: model.id === (this.buildMenu && this.shell?.planView ? this.shell.planView.buildModelId : catalog.selectedModelId)
            || Boolean(model.aliases?.includes(this.buildMenu && this.shell?.planView ? this.shell.planView.buildModelId : catalog.selectedModelId)),
          onSelect: () => this.post({ type: this.buildMenu ? 'setBuildModel' : 'setModel', modelId: model.id }),
        })),
        { id: 'refresh', label: copy?.refreshModels ?? 'Refresh', pinned: true, onSelect: () => this.requestCatalog(true) },
      ],
    };
  }

  private openEnvironment(): void {
    const shell = this.shell;
    const copy = this.copy;
    if (!shell || !copy) return;
    this.modelMenu.close(false);
    this.menu.open(this.env, [
      ...shell.folders.map((folder) => ({
        id: folder.path, label: folder.name, description: folder.path, checked: folder.path === shell.cwd,
        onSelect: () => this.post({ type: 'select', cwd: folder.path }),
      })),
      { id: 'settings', label: copy.settings, onSelect: () => this.onNavigate('settings') },
    ]);
  }

  private openChanges(anchor: HTMLElement, shell: ViewShell, copy: Copy): void {
    const entries = shell.changes.flatMap((change) => this.changeEntries(change, copy));
    this.menu.open(anchor, entries.length ? entries : [{ id: 'none', label: copy.changes }]);
  }

  private changeEntries(change: ViewChange, copy: Copy): { id: string; label: string; description?: string; onSelect?: () => void }[] {
    const stats = `${change.additions !== undefined ? `+${change.additions}` : ''} ${change.deletions !== undefined ? `−${change.deletions}` : ''}`.trim();
    const rows: { id: string; label: string; description?: string; onSelect?: () => void }[] = [{
      id: `open:${change.path}`, label: change.name, description: stats,
      onSelect: () => this.post({ type: change.canDiff ? 'openDiff' : 'openFile', path: change.path }),
    }];
    if (change.canRevert) rows.push({ id: `revert:${change.path}`, label: copy.revert, onSelect: () => this.post({ type: 'revertFile', path: change.path }) });
    if (change.patch) rows.push({ id: `patch:${change.path}`, label: copy.patch, description: change.patch.slice(0, 180) });
    return rows;
  }

  private configure(extra: Record<string, string>): void {
    const shell = this.shell;
    if (!shell) return;
    this.post({
      type: 'configure', mode: shell.mode, sandbox: shell.sandbox, approval: shell.approval,
      backend: shell.backend, network: shell.network, webSearch: shell.webSearch, ...extra,
    });
  }
}

function fileIcon(dom: Dom, change: ViewChange): HTMLElement {
  const icon = change.icon;
  if (icon?.type === 'image' && icon.src) {
    const image = dom.el('img', 'file-icon');
    image.alt = '';
    image.src = icon.src;
    return image;
  }
  if (icon?.type === 'font' && icon.fontCharacter) {
    const escaped = /^\\([0-9a-f]{1,6})\s?$/i.exec(icon.fontCharacter);
    const point = escaped ? Number.parseInt(escaped[1]!, 16) : undefined;
    if (point !== undefined && (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff)) return dom.el('span', 'file-badge', change.name.slice(0, 2).toUpperCase());
    const span = dom.el('span', 'file-icon font-icon', point === undefined ? icon.fontCharacter : String.fromCodePoint(point));
    if (icon.fontFamily) span.style.fontFamily = icon.fontFamily;
    if (icon.fontColor) span.style.color = icon.fontColor;
    return span;
  }
  return dom.el('span', 'file-badge', icon?.badge || change.name.slice(0, 2).toUpperCase());
}

export function caretToken(value: string, caret: number): CaretToken | undefined {
  const until = value.slice(0, caret);
  const file = until.match(/(^|\s)@([^\s@]*)$/);
  if (file?.[2] !== undefined) return { kind: 'file', query: file[2], start: until.length - file[2].length - 1 };
  const slash = until.match(/(^|\n)\/([\w-]*)$/);
  if (slash?.[2] !== undefined) return { kind: 'slash', query: slash[2], start: until.length - slash[2].length - 1 };
  return undefined;
}
