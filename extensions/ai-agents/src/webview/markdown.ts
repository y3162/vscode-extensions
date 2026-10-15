import type { Dom } from './dom.js';

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };

const rendered = new WeakMap<HTMLElement, { sigs: string[]; nodes: HTMLElement[] }>();

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  const next = () => lines[index] ?? '';
  while (index < lines.length) {
    const line = next();
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith('```')) code.push(lines[index++] ?? '');
      const closed = index < lines.length;
      if (closed) index += 1;
      blocks.push({ type: 'code', lang, code: code.join('\n'), closed });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({ type: 'heading', level: Math.min(heading[1].length, 3), text: heading[2] });
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { blocks.push({ type: 'hr' }); index += 1; continue; }
    if (isTableStart(lines, index)) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? '')) rows.push(splitRow(lines[index++] ?? ''));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /^\d+\./.test(list[2] ?? '');
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[index] ?? '');
        if (!item || /^\d+\./.test(item[2] ?? '') !== ordered) break;
        items.push(item[3] ?? '');
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index]?.startsWith('>') || !(lines[index] ?? '').trim())) {
        if (!(lines[index] ?? '').trim()) break;
        quote.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() && !special(lines[index] ?? '')) paragraph.push(lines[index++] ?? '');
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

function special(line: string): boolean {
  return line.startsWith('```') || line.startsWith('>') || /^(#{1,6})\s+/.test(line) || /^(\s*)([-*+]|\d+\.)\s+/.test(line) || /^\s*\|.*\|\s*$/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  return /^\s*\|.*\|\s*$/.test(lines[index] ?? '') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? '');
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

export function renderMarkdown(host: HTMLElement, source: string, dom: Dom, copyLabel = 'Copy'): void {
  const blocks = parseMarkdown(source);
  const sigs = blocks.map((block) => JSON.stringify(block));
  const state = rendered.get(host) ?? { sigs: [], nodes: [] };
  const nodes: HTMLElement[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const previous = state.nodes[index];
    if (previous && state.sigs[index] === sigs[index]) nodes.push(previous);
    else nodes.push(renderBlock(block, dom, copyLabel));
  }
  for (const node of state.nodes) if (!nodes.includes(node)) node.remove();
  let cursor: ChildNode | null = host.firstChild;
  for (const node of nodes) {
    if (cursor === node) cursor = cursor.nextSibling;
    else host.insertBefore(node, cursor);
  }
  rendered.set(host, { sigs, nodes });
}

function renderBlock(block: Block, dom: Dom, copyLabel: string): HTMLElement {
  switch (block.type) {
    case 'heading': return dom.el(block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4', undefined, block.text);
    case 'hr': return dom.el('hr');
    case 'paragraph': return inlineBlock('p', block.text, dom);
    case 'quote': return inlineBlock('blockquote', block.text, dom);
    case 'list': {
      const list = dom.el(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) list.append(inlineBlock('li', item, dom));
      return list;
    }
    case 'table': {
      const wrap = dom.el('div', 'table-wrap');
      const table = dom.el('table');
      const head = dom.el('tr');
      for (const cell of block.header) head.append(dom.el('th', undefined, cell));
      const thead = dom.el('thead');
      thead.append(head);
      const body = dom.el('tbody');
      for (const row of block.rows) {
        const tr = dom.el('tr');
        for (const cell of row) tr.append(inlineBlock('td', cell, dom));
        body.append(tr);
      }
      table.append(thead, body);
      wrap.append(table);
      return wrap;
    }
    case 'code': {
      const wrap = dom.el('div', 'code-block');
      if (block.lang) wrap.dataset.lang = block.lang;
      const bar = dom.el('div', 'code-bar');
      bar.append(dom.el('span', 'lang', block.lang));
      const copy = dom.button('ghost copy-code', copyLabel, 'copy');
      copy.dataset.action = 'copy-code';
      bar.append(copy);
      const pre = dom.el('pre');
      const code = dom.el('code');
      if (!block.closed || block.code.length > 12000) code.textContent = block.code;
      else code.append(highlight(block.code, block.lang, dom));
      pre.append(code);
      wrap.append(bar, pre);
      return wrap;
    }
    default: return dom.el('p');
  }
}

function inlineBlock(tag: 'p' | 'li' | 'blockquote' | 'td', text: string, dom: Dom): HTMLElement {
  const element = dom.el(tag);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index) element.append(dom.el('br'));
    renderInline(element, line, dom);
  });
  return element;
}

const inlinePattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|(?:[\w.+-]+\/)+[\w.+-]+\.\w+(?::\d+)?)/g;

export function renderInline(parent: HTMLElement, text: string, dom: Dom): void {
  const pattern = new RegExp(inlinePattern.source, 'g');
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) parent.append(text.slice(cursor, start));
    appendToken(parent, token, dom);
    cursor = start + token.length;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function appendToken(parent: HTMLElement, token: string, dom: Dom): void {
  if (token.startsWith('`') && token.endsWith('`')) {
    parent.append(dom.el('code', undefined, token.slice(1, -1)));
    return;
  }
  if (token.startsWith('**') && token.endsWith('**')) {
    parent.append(dom.el('strong', undefined, token.slice(2, -2)));
    return;
  }
  if (token.startsWith('*') && token.endsWith('*')) {
    parent.append(dom.el('em', undefined, token.slice(1, -1)));
    return;
  }
  const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
  if (link?.[1] && link[2]) {
    const anchor = dom.el('a', undefined, link[1]);
    anchor.href = link[2];
    anchor.rel = 'noreferrer noopener';
    parent.append(anchor);
    return;
  }
  const file = /^(.+?)(?::(\d+))?$/.exec(token);
  const button = dom.el('button', 'file-link', token);
  button.type = 'button';
  button.dataset.action = 'open-file';
  button.dataset.path = file?.[1] ?? token;
  if (file?.[2]) button.dataset.line = file[2];
  parent.append(button);
}

function highlight(code: string, lang: string, dom: Dom): DocumentFragment {
  const fragment = dom.document.createDocumentFragment();
  const kind = lang.toLowerCase();
  const keywords = keywordPattern(kind);
  if (!keywords) {
    fragment.append(code);
    return fragment;
  }
  const pattern = new RegExp(`(\\/\\/[^\\n]*|#(?!! )[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\\`(?:\\\\.|[^\\\`\\\\])*\\\`|\\b(?:${keywords})\\b|\\b\\d+(?:\\.\\d+)?\\b)`, 'g');
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) fragment.append(code.slice(cursor, start));
    const span = dom.el('span');
    span.className = token.startsWith('"') || token.startsWith("'") || token.startsWith('`') ? 'tok-str'
      : token.startsWith('/') || token.startsWith('#') ? 'tok-cmt'
        : /^\d/.test(token) ? 'tok-num' : 'tok-kw';
    span.textContent = token;
    fragment.append(span);
    cursor = start + token.length;
  }
  if (cursor < code.length) fragment.append(code.slice(cursor));
  return fragment;
}

function keywordPattern(lang: string): string | undefined {
  const groups: [RegExp, string][] = [
    [/^(js|jsx|ts|tsx|javascript|typescript)$/, 'const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|type|interface'],
    [/^(py|python)$/, 'def|return|if|elif|else|for|while|class|import|from|as|with|try|except|lambda|None|True|False'],
    [/^(sh|bash|zsh|shell)$/, 'if|then|else|fi|for|in|do|done|case|esac|function|return|echo'],
    [/^(go)$/, 'func|return|if|else|for|range|package|import|type|struct|var|const'],
    [/^(rs|rust)$/, 'fn|let|mut|return|if|else|for|while|struct|enum|impl|use|pub|mod'],
    [/^(css|scss)$/, ''],
    [/^(json)$/, ''],
  ];
  const found = groups.find(([pattern]) => pattern.test(lang));
  if (!found || !found[1]) return lang === 'json' || lang === 'css' || lang === 'scss' ? undefined : undefined;
  return found[1] || undefined;
}
