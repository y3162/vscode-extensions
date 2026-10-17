import type { ViewFileIcon } from '../protocol.js';
import type { Dom } from './dom.js';

const loadedIconFonts = new Set<string>();

export function fileIcon(dom: Dom, file: { name: string; icon?: ViewFileIcon }): HTMLElement {
  const icon = file.icon;
  if (icon?.type === 'image' && icon.src) {
    const image = dom.el('img', 'file-icon');
    image.alt = '';
    image.src = icon.src;
    return image;
  }
  if (icon?.type === 'font' && icon.fontCharacter) {
    const escaped = /^\\([0-9a-f]{1,6})\s?$/i.exec(icon.fontCharacter);
    const point = escaped ? Number.parseInt(escaped[1]!, 16) : undefined;
    if (point !== undefined && (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff)) return dom.el('span', 'file-badge', file.name.slice(0, 2).toUpperCase());
    if (icon.fontFamily && icon.src) ensureIconFont(dom.document, icon.fontFamily, icon.src);
    const span = dom.el('span', 'file-icon font-icon', point === undefined ? icon.fontCharacter : String.fromCodePoint(point));
    if (icon.fontFamily) span.style.fontFamily = icon.fontFamily;
    if (icon.fontColor) span.style.color = icon.fontColor;
    return span;
  }
  return dom.el('span', 'file-badge', icon?.badge || file.name.slice(0, 2).toUpperCase());
}

function ensureIconFont(document: Document, family: string, src: string): void {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const key = `${family}\0${src}`;
  if (loadedIconFonts.has(key)) return;
  loadedIconFonts.add(key);
  const face = new FontFace(family, `url(${JSON.stringify(src)})`);
  void face.load().then((loaded) => {
    document.fonts.add(loaded);
  }).catch(() => {
    loadedIconFonts.delete(key);
  });
}
