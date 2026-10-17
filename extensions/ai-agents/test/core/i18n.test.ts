import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localeFrom, translate } from '../../src/i18n.js';

test('localeFrom treats Japanese language tags as ja and everything else as en', () => {
  assert.equal(localeFrom('ja'), 'ja');
  assert.equal(localeFrom('JA-JP'), 'ja');
  assert.equal(localeFrom('japanese'), 'ja');
  assert.equal(localeFrom('en'), 'en');
  assert.equal(localeFrom('en-US'), 'en');
  assert.equal(localeFrom('fr'), 'en');
  assert.equal(localeFrom(''), 'en');
  assert.equal(localeFrom(undefined), 'en');
});

test('translate fills placeholders in the selected language', () => {
  assert.equal(translate('ja', 'error.modelList', 'boom'), 'モデル一覧を取得できませんでした: boom');
  assert.equal(translate('en', 'error.modelList', 'boom'), 'Could not load the model list: boom');
  assert.equal(translate('en', 'model.pickerTitle', 'Codex'), 'Select a Codex model');
  assert.equal(translate('ja', 'model.pickerTitle', 'Cursor'), 'Cursor のモデルを選択');
  assert.equal(translate('en', 'codex.exit', '1'), 'The Codex model-list process exited (1).');
  assert.equal(translate('en', 'error.noFolder'), 'Open a workspace folder in VS Code first.');
  assert.equal(translate('ja', 'error.noFolder', 'unused'), '作業対象のフォルダをVS Codeで開いてください。');
});
