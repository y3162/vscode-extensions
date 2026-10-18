import assert from 'node:assert/strict';

import { test } from 'node:test';

import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from '../../src/capabilities.js';

const mode = 0o644;

test('normalizeControls drops unsupported sandbox, search, network, and directories per backend', () => {
  const codex = capabilitiesFor('codex', 'sdk');
  assert.equal(codex.compact, false);
  assert.equal(codex.rateLimits, false);
  assert.equal(codex.modelSettings, 'new-session');
  assert.equal(codex.webSearch.some((item) => item.id === 'cached'), true);
  assert.equal(capabilitiesFor('cursor', 'sdk').networkToggle, false);
  assert.equal(capabilitiesFor('cursor', 'acp').additionalDirectories, false);
  assert.equal(defaultControls('cursor', 'acp').sandbox, 'enabled');
  assert.equal(defaultControls('codex', 'app-server').sandbox, 'workspace-write');
  const cursor = normalizeControls('cursor', { ...defaultControls('cursor', 'acp'), mode: 'ask', sandbox: 'danger-full-access', approval: 'on-request', network: true, webSearch: 'live', additionalDirectories: ['/tmp'] });
  assert.equal(cursor.mode, 'ask');
  assert.equal(cursor.sandbox, 'enabled');
  assert.equal(cursor.approval, 'never');
  assert.equal(cursor.network, false);
  assert.equal(cursor.webSearch, '');
  assert.deepEqual(cursor.additionalDirectories, []);
  const kept = normalizeControls('codex', { ...defaultControls('codex', 'app-server'), mode: 'plan', sandbox: 'read-only', approval: 'on-request', webSearch: 'cached', network: true, additionalDirectories: ['/workspace/extra'] });
  assert.equal(kept.mode, 'plan');
  assert.equal(kept.sandbox, 'read-only');
  assert.equal(kept.approval, 'on-request');
  assert.equal(kept.webSearch, 'cached');
  assert.equal(kept.network, true);
  assert.deepEqual(kept.additionalDirectories, ['/workspace/extra']);
  const invalid = normalizeControls('codex', { ...defaultControls('codex', 'sdk'), mode: 'ask' as AgentControls['mode'], sandbox: 'enabled', approval: 'on-request', webSearch: 'nope' });
  assert.equal(invalid.mode, 'agent');
  assert.equal(invalid.sandbox, 'workspace-write');
  assert.equal(invalid.approval, 'never');
  assert.equal(invalid.webSearch, '');
});;
