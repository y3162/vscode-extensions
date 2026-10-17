import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { redactSecrets } from '../../src/types.js';
import { extensionVersion } from '../../src/version.js';

test('the extension version matches package.json', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version: string };
  assert.equal(manifest.version, extensionVersion);
});

test('secret-shaped text is redacted before it is shown', () => {
  assert.match(redactSecrets('token=abc123'), /token=\[redacted\]/);
  assert.match(redactSecrets('sk-live-secret-value'), /sk-\[redacted\]/);
  assert.equal(redactSecrets('ordinary failure'), 'ordinary failure');
});
