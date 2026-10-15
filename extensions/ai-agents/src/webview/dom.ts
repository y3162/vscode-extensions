export interface Dom {
  document: Document;
  el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K];
  icon(name: string): HTMLSpanElement;
  button(className: string, label: string, iconName?: string): HTMLButtonElement;
}

export function isElement(value: unknown): value is HTMLElement {
  return !!value && typeof value === 'object' && (value as { nodeType?: number }).nodeType === 1;
}

export function isButton(value: unknown): value is HTMLButtonElement {
  return isElement(value) && value.tagName === 'BUTTON';
}

export function isInput(value: unknown): value is HTMLInputElement {
  return isElement(value) && value.tagName === 'INPUT';
}

export function createDom(document: Document): Dom {
  return {
    document,
    el(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    },
    icon(name) {
      const element = document.createElement('span');
      const [base, ...modifiers] = name.split('~');
      element.className = ['codicon', `codicon-${base}`, ...modifiers.map((modifier) => `codicon-modifier-${modifier}`)].join(' ');
      element.setAttribute('aria-hidden', 'true');
      return element;
    },
    button(className, label, iconName) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.title = label;
      element.setAttribute('aria-label', label);
      if (iconName) element.append(this.icon(iconName));
      const caption = document.createElement('span');
      caption.className = 'btn-label';
      caption.textContent = label;
      element.append(caption);
      return element;
    },
  };
}
