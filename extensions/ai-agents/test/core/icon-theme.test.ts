import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveThemeIcon, type IconThemeDocument } from '../../src/icon-theme.js';

const theme: IconThemeDocument = {
  iconDefinitions: {
    readme: { iconPath: './icons/readme.svg' },
    markdown: { iconPath: './icons/markdown.svg' },
    file: { iconPath: './icons/file.svg' },
    fontOnly: { fontCharacter: '\\e001', fontColor: '#89b4fa', fontId: 'codicon' },
    both: { iconPath: './icons/both.svg', fontCharacter: 'B' },
    empty: {},
  },
  fonts: [
    { id: 'first', src: [{ path: './fonts/first.ttf', format: 'truetype' }] },
    { id: 'codicon', src: [{ path: './fonts/codicon.ttf', format: 'truetype' }] },
    { id: 'blank', src: [{ path: '' }] },
  ],
  file: 'file',
  fileExtensions: { md: 'markdown', 'tar.gz': 'archive', gz: 'gzip' },
  fileNames: { 'README.md': 'readme', 'readme.md': 'lower' },
  light: {
    fileExtensions: { md: 'light-md' },
    iconDefinitions: { 'light-md': { iconPath: './icons/light-md.svg' } },
  },
  highContrast: {
    fileExtensions: { ts: 'hc-ts' },
    iconDefinitions: { 'hc-ts': { fontCharacter: 'T', fontColor: '#fff', fontId: 'codicon' } },
  },
};

test('file names win over extensions, including compound suffixes and path basenames', () => {
  assert.deepEqual(resolveThemeIcon(theme, 'README.md'), { type: 'image', iconPath: './icons/readme.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'docs/other.md'), { type: 'image', iconPath: './icons/markdown.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'notes.txt'), { type: 'image', iconPath: './icons/file.svg' });
  assert.deepEqual(resolveThemeIcon(theme, String.raw`dir\README.md`), { type: 'image', iconPath: './icons/readme.svg' });
  const archive = resolveThemeIcon({ ...theme, fileNames: {}, iconDefinitions: { ...theme.iconDefinitions, archive: { iconPath: 'archive.svg' }, gzip: { iconPath: 'gzip.svg' } } }, 'bundle.tar.gz');
  assert.deepEqual(archive, { type: 'image', iconPath: 'archive.svg' });
});

test('a lowercase fileNames key matches a differently cased file', () => {
  const lower: IconThemeDocument = { ...theme, fileNames: { 'readme.md': 'lower' }, iconDefinitions: { ...theme.iconDefinitions, lower: { iconPath: 'lower.svg' } } };
  assert.deepEqual(resolveThemeIcon(lower, 'README.md'), { type: 'image', iconPath: 'lower.svg' });
});

test('light and high contrast layers override the dark theme and dark ignores them', () => {
  assert.deepEqual(resolveThemeIcon(theme, 'notes.md', 'light'), { type: 'image', iconPath: './icons/light-md.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'app.ts', 'light'), { type: 'image', iconPath: './icons/file.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'app.ts', 'dark'), { type: 'image', iconPath: './icons/file.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'app.ts'), { type: 'image', iconPath: './icons/file.svg' });
  assert.deepEqual(resolveThemeIcon(theme, 'app.ts', 'highContrast'), {
    type: 'font', fontCharacter: 'T', fontColor: '#fff', fontPath: './fonts/codicon.ttf', format: 'truetype', fontFamily: 'codicon',
  });
});

test('image, font, and badge results follow the definition that matched', () => {
  const bare: IconThemeDocument = { ...theme, file: 'fontOnly', fileNames: {}, fileExtensions: {} };
  assert.deepEqual(resolveThemeIcon(bare, 'any.txt'), {
    type: 'font', fontCharacter: '\\e001', fontColor: '#89b4fa', fontPath: './fonts/codicon.ttf', format: 'truetype', fontFamily: 'codicon',
  });
  const withPath: IconThemeDocument = { ...bare, file: 'both' };
  assert.deepEqual(resolveThemeIcon(withPath, 'any.txt'), {
    type: 'font', iconPath: './icons/both.svg', fontCharacter: 'B', fontPath: './fonts/first.ttf', format: 'truetype', fontFamily: 'first',
  });
  const noFonts: IconThemeDocument = { file: 'fontOnly', iconDefinitions: { fontOnly: { fontCharacter: '?' } } };
  assert.deepEqual(resolveThemeIcon(noFonts, 'any.txt'), { type: 'font', fontCharacter: '?', fontFamily: 'ai-agents-file-icons' });
  const blankFont: IconThemeDocument = { file: 'fontOnly', iconDefinitions: { fontOnly: { fontCharacter: '?', fontId: 'blank' } }, fonts: [{ id: 'blank', src: [{ path: '' }] }] };
  assert.deepEqual(resolveThemeIcon(blankFont, 'any.txt'), { type: 'font', fontCharacter: '?', fontFamily: 'blank' });
  const missingFont: IconThemeDocument = { file: 'fontOnly', iconDefinitions: { fontOnly: { fontCharacter: '?', fontId: 'missing' } }, fonts: [{ id: 'fallback', src: [{ path: 'fallback.ttf' }] }] };
  assert.deepEqual(resolveThemeIcon(missingFont, 'any.txt'), { type: 'font', fontCharacter: '?', fontPath: 'fallback.ttf', format: undefined, fontFamily: 'fallback' });
  assert.deepEqual(resolveThemeIcon({ iconDefinitions: { file: {} }, file: 'file' }, 'any.txt'), { type: 'badge' });
  assert.deepEqual(resolveThemeIcon({}, 'any.txt'), { type: 'badge' });
  assert.deepEqual(resolveThemeIcon({ light: { file: 'missing' } }, 'any.txt', 'light'), { type: 'badge' });
});
