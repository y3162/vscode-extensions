import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Window } from 'happy-dom';

import type { ModelCatalogMessage, ViewMessage, ViewPlan, ViewShell } from '../../src/protocol.js';

import { Composer } from '../../src/webview/composer.js';

import { createDom } from '../../src/webview/dom.js';

import { Menu, ModelMenu } from '../../src/webview/popover.js';

function bootComposer() {
  const window = new Window();
  const dom = createDom(window.document);
  const host = dom.el('div');
  window.document.body.append(host);
  const menu = new Menu(dom, host);
  const sent: unknown[] = [];
  const composer = new Composer(dom, host, (message) => sent.push(message), menu, () => {});
  return { window, document: window.document, dom, host, menu, composer, sent };
}

test('composer pre-render guards avoid posting and expose plain-English model-list defaults', () => {
  const { window, composer, sent } = bootComposer();
  const internal = composer as unknown as {
    requestCatalog(refresh: boolean): void;
    setCatalog(message: ModelCatalogMessage): void;
    modelPage(): { items: unknown[] };
    modelListPage(catalog: ModelCatalogMessage): { backLabel?: string; search?: { placeholder: string; empty: string }; items: { label: string }[] };
    configure(extra: Record<string, string>): void;
  };
  internal.requestCatalog(false);
  internal.setCatalog({ type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId: 1, status: 'ready', models: [], selectedModelId: '', selectedParams: [] });
  internal.configure({ mode: 'plan' });
  assert.deepEqual(sent, [], 'catalog and configure requests require a rendered shell');
  assert.deepEqual(internal.modelPage(), { items: [] });
  const fallback = internal.modelListPage({ type: 'modelCatalog', provider: 'codex', cwd: '/workspace', requestId: 1, status: 'ready', models: [], selectedModelId: '', selectedParams: [] });
  assert.deepEqual(fallback.search, { placeholder: 'Search models', empty: 'No matching models' });
  assert.equal(fallback.items.at(-1)?.label, 'Refresh');
  window.happyDOM.abort();
});
