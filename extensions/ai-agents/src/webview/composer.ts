import type { Post } from './cards.js';
import type { Dom } from './dom.js';
import type { Menu } from './popover.js';
import type { ViewChange, ViewShell } from '../protocol.js';
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
  private readonly access: HTMLButtonElement;
  private readonly model: HTMLButtonElement;
  private readonly effort: HTMLButtonElement;
  private readonly send: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly env: HTMLButtonElement;
  private shell: ViewShell | null = null;
  private copy: Copy | null = null;
  private composing = false;
  private composeEnded = 0;
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
    this.attach = dom.button('icon-btn', 'Attach', 'add');
    this.attach.addEventListener('click', () => this.openAttach(this.attach));
    this.mode = dom.button('pill', 'Mode', 'sparkle');
    this.mode.setAttribute('aria-haspopup', 'menu');
    this.mode.addEventListener('click', () => this.openMode());
    this.access = dom.button('pill', 'Access', 'shield');
    this.access.setAttribute('aria-haspopup', 'menu');
    this.access.addEventListener('click', () => this.openAccess());
    left.append(this.attach, this.mode, this.access);
    const right = dom.el('div', 'row-right');
    this.model = dom.button('pill model-name', 'Model');
    this.model.addEventListener('click', () => this.post({ type: 'chooseModel' }));
    this.effort = dom.button('pill effort', 'Details');
    this.effort.addEventListener('click', () => this.post({ type: 'modelDetails' }));
    this.stop = dom.button('icon-btn stop', 'Stop', 'debug-stop');
    this.stop.hidden = true;
    this.stop.addEventListener('click', () => this.post({ type: 'stop' }));
    this.send = dom.button('send', 'Send', 'arrow-up');
    this.send.addEventListener('click', () => this.submit());
    right.append(this.model, this.effort, this.stop, this.send);
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
    this.fileInput = file;
    form.addEventListener('submit', (event) => { event.preventDefault(); this.submit(); });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.composeEnded = Date.now(); });
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
    this.input.placeholder = copy.placeholder;
    this.input.setAttribute('aria-label', copy.placeholder);
    this.togglePill(this.mode, shell.showMode, shell.modes.find((mode) => mode.id === shell.mode)?.label ?? shell.mode, copy.mode);
    this.togglePill(this.access, true, shell.accessLabel, copy.access);
    this.access.classList.toggle('risky', shell.risky);
    const modelLabel = this.model.querySelector('.btn-label');
    if (modelLabel) modelLabel.textContent = shell.modelLabel;
    this.model.title = shell.modelLabel;
    this.model.setAttribute('aria-label', shell.modelLabel);
    this.model.disabled = shell.busy;
    this.effort.hidden = !shell.effortLabel;
    const effortLabel = this.effort.querySelector('.btn-label');
    if (effortLabel && shell.effortLabel) effortLabel.textContent = shell.effortLabel;
    if (shell.effortLabel) {
      this.effort.title = shell.effortLabel;
      this.effort.setAttribute('aria-label', shell.effortLabel);
    }
    this.attach.title = copy.attach;
    this.attach.setAttribute('aria-label', copy.attach);
    this.effort.disabled = shell.busy || !shell.effortLabel;
    this.mode.disabled = shell.busy;
    this.access.disabled = shell.busy;
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
    this.changes.hidden = !count;
    this.changes.replaceChildren();
    if (!count) return;
    const button = this.dom.button('change-summary', `${count} ${copy.changes}  +${shell.additions}  −${shell.deletions}`, 'diff');
    button.addEventListener('click', () => this.openChanges(button, shell, copy));
    this.changes.append(button);
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
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (this.composing || event.isComposing || event.keyCode === 229 || Date.now() - this.composeEnded < 100) return;
    if (!this.suggest.hidden && this.suggestItems[this.suggestIndex]) {
      event.preventDefault();
      this.applySuggestion(this.suggestItems[this.suggestIndex]);
      return;
    }
    event.preventDefault();
    this.submit();
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
    this.menu.open(this.mode, shell.modes.map((mode) => ({
      id: mode.id, label: mode.label, description: mode.description, checked: mode.id === shell.mode,
      onSelect: () => this.configure({ mode: mode.id }),
    })));
  }

  private openAccess(): void {
    const shell = this.shell;
    const copy = this.copy;
    if (!shell || !copy) return;
    this.menu.open(this.access, [
      ...shell.sandboxChoices.map((item) => ({
        id: `sandbox:${item.id}`, label: item.label, description: item.description, checked: item.id === shell.sandbox,
        onSelect: () => this.configure({ sandbox: item.id }),
      })),
      ...shell.showApproval ? shell.approvalChoices.map((item) => ({
        id: `approval:${item.id}`, label: item.label, description: item.description, checked: item.id === shell.approval,
        onSelect: () => this.configure({ approval: item.id }),
      })) : [],
      { id: 'auto', label: copy.autoApprove, description: shell.autoApprove ? 'On' : 'Off', onSelect: () => this.post({ type: 'toggleAutoApprove' }) },
      { id: 'note', label: copy.sandboxNote },
    ]);
  }

  private openEnvironment(): void {
    const shell = this.shell;
    const copy = this.copy;
    if (!shell || !copy) return;
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

export function caretToken(value: string, caret: number): CaretToken | undefined {
  const until = value.slice(0, caret);
  const file = until.match(/(^|\s)@([^\s@]*)$/);
  if (file?.[2] !== undefined) return { kind: 'file', query: file[2], start: until.length - file[2].length - 1 };
  const slash = until.match(/(^|\n)\/([\w-]*)$/);
  if (slash?.[2] !== undefined) return { kind: 'slash', query: slash[2], start: until.length - slash[2].length - 1 };
  return undefined;
}
