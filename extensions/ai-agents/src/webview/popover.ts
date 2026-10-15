import type { Dom } from './dom.js';

export interface MenuEntry {
  id: string;
  label: string;
  description?: string;
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
      const label = this.dom.el('span', 'menu-label', entry.label);
      button.append(label);
      if (entry.description) {
        button.title = entry.description;
        button.append(this.dom.el('small', undefined, entry.description));
      }
      if (entry.checked) button.append(this.dom.icon('check'));
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
    this.element.style.left = `${Math.max(8, Math.min(rect.left, width - 220))}px`;
    this.element.style.right = 'auto';
    this.element.style.bottom = 'auto';
    this.element.style.top = `${rect.bottom + 6}px`;
    const box = this.element.getBoundingClientRect();
    if (box.bottom > height - 8) {
      this.element.style.top = 'auto';
      this.element.style.bottom = `${height - rect.top + 6}px`;
    }
  }
}
