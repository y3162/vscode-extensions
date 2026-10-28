import type { Dom } from './dom.js';

export interface MenuEntry {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export class Menu {
  readonly element: HTMLDivElement;
  private trigger: HTMLElement | null = null;
  private items: HTMLButtonElement[] = [];
  private index = 0;
  private readonly onPointer = (event: Event) => {
    const target = event.target;
    if (!target || typeof target !== 'object' || !('nodeType' in target)) return;
    if (this.element.contains(target as Node) || this.trigger?.contains(target as Node)) return;
    this.close(false);
  };
  private readonly onKey = (event: KeyboardEvent) => {
    if (this.element.hidden) return;
    const last = this.items.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); this.focusItem(this.index >= last ? 0 : this.index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); this.focusItem(this.index <= 0 ? last : this.index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); this.focusItem(0); }
    else if (event.key === 'End') { event.preventDefault(); this.focusItem(last); }
    else if (event.key === 'Escape') { event.preventDefault(); this.close(true); }
    else if (event.key === 'Tab') this.close(false);
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.items[this.index]?.click(); }
  };

  constructor(private readonly dom: Dom, parent: HTMLElement) {
    this.element = dom.el('div', 'menu');
    this.element.hidden = true;
    this.element.role = 'menu';
    this.element.tabIndex = -1;
    parent.append(this.element);
    this.element.addEventListener('keydown', this.onKey);
  }

  get isOpen(): boolean { return !this.element.hidden; }

  open(trigger: HTMLElement, entries: MenuEntry[]): void {
    this.close(false);
    this.trigger = trigger;
    this.element.replaceChildren();
    this.items = [];
    const radio = entries.some((entry) => entry.checked !== undefined && !entry.disabled);
    for (const entry of entries) {
      if (!entry.onSelect) {
        const note = this.dom.el('p', 'menu-note', entry.label);
        if (entry.description) note.title = entry.description;
        this.element.append(note);
        continue;
      }
      const button = this.dom.el('button', 'menu-item');
      button.type = 'button';
      button.role = radio ? 'menuitemradio' : 'menuitem';
      button.dataset.id = entry.id;
      if (entry.checked) button.setAttribute('aria-checked', 'true');
      else if (radio) button.setAttribute('aria-checked', 'false');
      button.disabled = Boolean(entry.disabled);
      if (entry.icon === 'infinity') {
        const glyph = this.dom.el('span', 'menu-glyph', '∞');
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
      } else if (entry.icon) button.append(this.dom.icon(entry.icon));
      const label = this.dom.el('span', 'menu-label', entry.label);
      button.append(label);
      if (entry.description) {
        button.title = entry.description;
        button.append(this.dom.el('small', undefined, entry.description));
      }
      if (entry.checked) {
        const check = this.dom.icon('check');
        check.classList.add('menu-check');
        button.append(check);
      }
      button.addEventListener('click', () => { const select = entry.onSelect; this.close(true); select?.(); });
      this.element.append(button);
      if (!button.disabled) this.items.push(button);
    }
    this.element.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this.place(trigger);
    this.focusItem(Math.max(0, this.items.findIndex((item) => item.getAttribute('aria-checked') === 'true')));
    this.dom.document.addEventListener('pointerdown', this.onPointer);
  }

  close(restoreFocus: boolean): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.element.replaceChildren();
    this.items = [];
    this.trigger?.setAttribute('aria-expanded', 'false');
    const trigger = this.trigger;
    this.trigger = null;
    this.dom.document.removeEventListener('pointerdown', this.onPointer);
    if (restoreFocus) trigger?.focus();
  }

  private focusItem(index: number): void {
    this.index = index;
    this.items.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === index));
    this.items[index]?.focus();
  }

  private place(trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const view = this.dom.document.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    this.element.style.left = '0px';
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
    this.element.style.top = `${rect.bottom + 6}px`;
    const box = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(8, Math.min(rect.left, width - (box.width || 220) - 8))}px`;
    if (box.bottom > height - 8) {
      this.element.style.top = 'auto';
      this.element.style.bottom = `${height - rect.top + 6}px`;
    }
  }
}

export interface ModelMenuItem {
  id: string;
  label: string;
  icon?: string;
  valueLabel?: string;
  description?: string;
  searchText?: string;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  toggle?: boolean;
  pinned?: boolean;
  submenu?: () => ModelMenuPage;
  onSelect?: () => void;
}

export interface ModelMenuPage {
  backLabel?: string;
  search?: { placeholder: string; empty: string };
  items: ModelMenuItem[];
}

export class ModelMenu {
  readonly element: HTMLDivElement;
  private readonly child: HTMLDivElement;
  private trigger: HTMLElement | null = null;
  private rootPage: ModelMenuPage = { items: [] };
  private childPage: ModelMenuPage | null = null;
  private drill = false;
  private query = '';
  private readonly onPointer = (event: Event) => {
    const target = event.target;
    if (!target || typeof target !== 'object' || !('nodeType' in target)) return;
    const node = target as Node;
    if (this.element.contains(node) || this.child.contains(node) || this.trigger?.contains(node)) return;
    this.close(false);
  };
  private readonly onKey = (event: KeyboardEvent) => {
    if (this.element.hidden) return;
    const panel = event.currentTarget === this.child ? this.child : this.element;
    const search = panel.querySelector('input');
    const inSearch = event.target === search;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.childPage) this.closeChild();
      else this.close(true);
      return;
    }
    if (event.key === 'Tab') { this.close(false); return; }
    if (inSearch && event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button.menu-item:not([disabled])')];
    const current = buttons.findIndex((button) => button.classList.contains('active'));
    if (event.key === 'ArrowDown') { event.preventDefault(); this.focusButtons(buttons, inSearch ? 0 : current + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); this.focusButtons(buttons, current <= 0 ? buttons.length - 1 : current - 1); }
    else if (event.key === 'Home') { event.preventDefault(); this.focusButtons(buttons, 0); }
    else if (event.key === 'End') { event.preventDefault(); this.focusButtons(buttons, buttons.length - 1); }
    else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const button = buttons[Math.max(current, 0)];
      if (button?.getAttribute('aria-haspopup') === 'menu') button.click();
    }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (this.childPage) this.closeChild(); }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const button = inSearch ? buttons[0] : buttons[Math.max(current, 0)];
      button?.click();
    }
  };

  constructor(private readonly dom: Dom, parent: HTMLElement) {
    this.element = dom.el('div', 'menu model-menu');
    this.child = dom.el('div', 'menu model-menu submenu');
    for (const panel of [this.element, this.child]) {
      panel.hidden = true;
      panel.role = 'menu';
      panel.tabIndex = -1;
      panel.addEventListener('keydown', this.onKey);
    }
    parent.append(this.element, this.child);
  }

  get isOpen(): boolean { return !this.element.hidden; }

  open(trigger: HTMLElement, page: ModelMenuPage): void {
    this.close(false);
    this.trigger = trigger;
    this.rootPage = page;
    this.childPage = null;
    this.drill = false;
    this.query = '';
    this.element.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    this.render();
    this.dom.document.addEventListener('pointerdown', this.onPointer);
  }

  replace(page: ModelMenuPage): void {
    if (!this.isOpen) return;
    this.rootPage = page;
    this.childPage = null;
    this.drill = false;
    this.query = '';
    this.render();
  }

  close(restoreFocus: boolean): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.child.hidden = true;
    this.element.replaceChildren();
    this.child.replaceChildren();
    this.childPage = null;
    this.trigger?.setAttribute('aria-expanded', 'false');
    const trigger = this.trigger;
    this.trigger = null;
    this.dom.document.removeEventListener('pointerdown', this.onPointer);
    if (restoreFocus) trigger?.focus();
  }

  private openChild(page: ModelMenuPage): void {
    this.childPage = page;
    this.query = '';
    const view = this.dom.document.defaultView;
    const width = view?.innerWidth ?? 800;
    const rect = this.element.getBoundingClientRect();
    const roomRight = width - rect.right;
    const roomLeft = rect.left;
    this.drill = width < 360 || (roomRight < 200 && roomLeft < 200);
    this.render();
  }

  private closeChild(): void {
    this.childPage = null;
    this.drill = false;
    this.query = '';
    this.render();
  }

  private render(): void {
    const trigger = this.trigger;
    this.element.replaceChildren();
    this.child.replaceChildren();
    if (this.drill && this.childPage) {
      this.renderPage(this.element, this.childPage, true);
      this.child.hidden = true;
    } else {
      this.renderPage(this.element, this.rootPage, false);
      if (this.childPage) {
        this.renderPage(this.child, this.childPage, false);
        this.child.hidden = false;
      } else this.child.hidden = true;
    }
    if (trigger) this.place(trigger);
    if (!this.child.hidden) this.placeChild();
    this.focusInitial();
  }

  private renderPage(host: HTMLElement, page: ModelMenuPage, back: boolean): void {
    if (back) {
      const button = this.dom.el('button', 'menu-item menu-back');
      button.type = 'button';
      button.dataset.id = 'back';
      button.append(this.dom.icon('arrow-left'), this.dom.el('span', 'menu-label', page.backLabel || 'Back'));
      button.addEventListener('click', () => this.closeChild());
      host.append(button);
    }
    if (page.search) {
      const input = this.dom.el('input', 'menu-search');
      input.type = 'search';
      input.placeholder = page.search.placeholder;
      input.setAttribute('aria-label', page.search.placeholder);
      input.value = this.query;
      input.addEventListener('input', () => {
        this.query = input.value;
        const scroll = host.querySelector('.menu-scroll');
        if (scroll) this.fill(scroll, page);
      });
      host.append(input);
    }
    const scroll = this.dom.el('div', 'menu-scroll');
    host.append(scroll);
    this.fill(scroll, page);
  }

  private fill(scroll: Element, page: ModelMenuPage): void {
    scroll.replaceChildren();
    const visible = page.items.filter((item) => item.pinned || this.matches(page, item));
    const listed = visible.filter((item) => !item.pinned);
    if (page.search && !listed.length) scroll.append(this.dom.el('p', 'menu-note', page.search.empty));
    const radio = page.items.some((item) => item.checked && !item.toggle);
    for (const item of visible) {
      if (item.separatorBefore) scroll.append(this.dom.el('div', 'menu-sep'));
      if (!item.onSelect && !item.submenu && !item.toggle) {
        const note = this.dom.el('p', 'menu-note', item.label);
        if (item.description) note.title = item.description;
        scroll.append(note);
        continue;
      }
      const button = this.dom.el('button', 'menu-item');
      button.type = 'button';
      button.dataset.id = item.id;
      button.role = item.toggle ? 'menuitemcheckbox' : radio ? 'menuitemradio' : 'menuitem';
      button.disabled = Boolean(item.disabled);
      if (item.toggle || radio) button.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      if (item.submenu) button.setAttribute('aria-haspopup', 'menu');
      button.title = item.description ? `${item.label} — ${item.description}` : item.label;
      if (item.icon) {
        const icon = this.dom.icon(item.icon);
        icon.classList.add('model-menu-icon');
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
      }
      button.append(this.dom.el('span', 'menu-label', item.label));
      if (item.valueLabel) button.append(this.dom.el('span', 'menu-value', item.valueLabel));
      if (item.toggle) button.append(this.dom.el('span', item.checked ? 'switch on' : 'switch'));
      if (item.submenu) button.append(this.dom.icon('chevron-right'));
      if (item.checked && !item.toggle) {
        const check = this.dom.icon('check');
        check.classList.add('menu-check');
        button.append(check);
      }
      button.addEventListener('click', () => {
        if (item.submenu) { this.openChild(item.submenu()); return; }
        const select = item.onSelect;
        if (!item.pinned) this.close(true);
        select?.();
      });
      scroll.append(button);
    }
  }

  private matches(page: ModelMenuPage, item: ModelMenuItem): boolean {
    if (!page.search) return true;
    const needle = this.query.trim().toLowerCase();
    if (!needle) return true;
    return [item.label, item.valueLabel, item.description, item.searchText, item.id].some((field) => field?.toLowerCase().includes(needle));
  }

  private focusInitial(): void {
    const panel = !this.child.hidden ? this.child : this.element;
    const search = panel.querySelector('input');
    if (search && 'focus' in search) { search.focus(); return; }
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button.menu-item:not([disabled])')];
    const selected = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true');
    this.focusButtons(buttons, selected >= 0 ? selected : 0);
  }

  private focusButtons(buttons: HTMLButtonElement[], index: number): void {
    if (!buttons.length) return;
    const next = (index + buttons.length) % buttons.length;
    buttons.forEach((button, itemIndex) => button.classList.toggle('active', itemIndex === next));
    buttons[next]?.focus();
  }

  private place(trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const view = this.dom.document.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    const box = this.element.getBoundingClientRect();
    const menuWidth = box.width || 220;
    const menuHeight = box.height || 40;
    const left = Math.max(8, Math.min(rect.left, width - menuWidth - 8));
    let top = rect.bottom + 6;
    if (top + menuHeight > height - 8) top = Math.max(8, rect.top - menuHeight - 6);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  private placeChild(): void {
    const root = this.element.getBoundingClientRect();
    const view = this.dom.document.defaultView;
    const width = view?.innerWidth ?? 800;
    const height = view?.innerHeight ?? 600;
    this.child.style.right = 'auto';
    this.child.style.bottom = 'auto';
    this.child.style.left = '0px';
    this.child.style.top = '0px';
    const box = this.child.getBoundingClientRect();
    const menuWidth = box.width || 220;
    const menuHeight = box.height || 40;
    let left = root.right + 4;
    if (left + menuWidth > width - 8) left = Math.max(8, root.left - menuWidth - 4);
    let top = root.top;
    if (top + menuHeight > height - 8) top = Math.max(8, height - menuHeight - 8);
    this.child.style.left = `${left}px`;
    this.child.style.top = `${top}px`;
  }
}
