import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runProcess } from '../../src/diagnostics.js';

test('runProcess reports a timeout without keeping the child alive', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], undefined, 200);
  assert.equal(result.ok, false);
  assert.match(result.output, /Timed out/);
  assert.match(result.label, /node|process/);
});

test('runProcess returns trimmed output, non-zero exits, and spawn errors', async () => {
  const ok = await runProcess(process.execPath, ['-e', 'console.log("token=abc123 sk-abcdefghij")']);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /token=\[redacted\]/);
  assert.match(ok.output, /sk-\[redacted\]/);
  assert.doesNotMatch(ok.output, /abc123|abcdefghij/);

  const failed = await runProcess(process.execPath, ['-e', 'console.error("boom"); process.exit(2)']);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /boom/);

  const empty = await runProcess(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(empty.ok, true);
  assert.equal(empty.output, 'exit 0');

  const missing = await runProcess('/no/such/ai-agents-diagnostic-bin', ['--version']);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /ENOENT|no such file|not found/i);
});

test('a JavaScript diagnostic command runs under the current executable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-diag-'));
  try {
    const script = path.join(root, 'check.js');
    writeFileSync(script, 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "")');
    const result = await runProcess(script, []);
    assert.equal(result.ok, true);
    assert.equal(result.output, '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
