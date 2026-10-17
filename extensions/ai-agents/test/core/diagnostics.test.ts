import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cursorRuntimeDiagnostics, runProcess, type CursorDiagnosticEnvironment } from '../../src/diagnostics.js';

function diagnosticEnvironment(overrides: Partial<CursorDiagnosticEnvironment> = {}): CursorDiagnosticEnvironment {
  return {
    platform: 'linux', arch: 'x64', nodeVersion: 'v22.1.0', execPath: '/synthetic/node', entry: undefined,
    homeDirectory: '/synthetic/home', resolveSdkManifest: () => '/synthetic/sdk/package.json',
    existsSync: () => false, statMode: () => 0, ...overrides,
  };
}

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

test('cursor runtime diagnostics reads sandbox policy files and does not modify them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-sandbox-'));
  const files = [path.join(homedir(), '.cursor', 'sandbox.json'), path.join(root, '.cursor', 'sandbox.json')];
  const before = files.map((file) => existsSync(file) ? readFileSync(file) : null);
  try {
    const checks = cursorRuntimeDiagnostics(root);
    const after = files.map((file) => existsSync(file) ? readFileSync(file) : null);
    assert.deepEqual(after.map((bytes) => bytes?.toString('utf8') ?? null), before.map((bytes) => bytes?.toString('utf8') ?? null));
    assert.equal(checks[0]?.label, 'Extension Host');
    assert.equal(checks[0]?.ok, true);
    assert.match(checks[0]?.output ?? '', new RegExp(process.versions.node));
    const helper = checks.find((check) => check.label === 'Cursor sandbox helper');
    assert.ok(helper);
    assert.match(helper.output, /cursorsandbox|Missing @cursor\/sdk/);
    const policies = checks.filter((check) => check.label === 'Sandbox policy');
    assert.equal(policies.length, 2);
    for (const policy of policies) {
      assert.equal(policy.ok, true);
      assert.match(policy.output, /present \(not modified\)|absent/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cursor helper diagnostics cover synthetic Linux and Windows runtimes without changing process state', () => {
  let statCalls = 0;
  const linux = cursorRuntimeDiagnostics('/synthetic/workspace', diagnosticEnvironment({
    entry: undefined,
    resolveSdkManifest(packageName) {
      assert.equal(packageName, '@cursor/sdk-linux-x64/package.json');
      return '/synthetic/sdk/package.json';
    },
    existsSync(file) { return file === '/synthetic/sdk/bin/cursorsandbox' || file.endsWith('/workspace/.cursor/sandbox.json'); },
    statMode(file) { statCalls += 1; assert.equal(file, '/synthetic/sdk/bin/cursorsandbox'); return 0o100755; },
  }));
  assert.equal(linux[0]?.output.includes('entry: (none)'), true);
  assert.deepEqual(linux.find((item) => item.label === 'Cursor sandbox helper'), {
    label: 'Cursor sandbox helper', ok: true, output: '/synthetic/sdk/bin/cursorsandbox',
  });
  assert.equal(statCalls, 1);
  assert.match(linux.at(-1)?.output ?? '', /present \(not modified\)/);

  statCalls = 0;
  const missingBinary = cursorRuntimeDiagnostics('/workspace', diagnosticEnvironment({
    existsSync: () => false,
    statMode() { statCalls += 1; return 0o100755; },
  }));
  assert.equal(missingBinary.find((item) => item.label === 'Cursor sandbox helper')?.ok, false);
  assert.equal(statCalls, 0, 'an absent helper is not passed to stat');

  const nonExecutable = cursorRuntimeDiagnostics('/workspace', diagnosticEnvironment({
    existsSync: (file) => file.endsWith('/cursorsandbox'), statMode: () => 0o100644,
  }));
  assert.equal(nonExecutable.find((item) => item.label === 'Cursor sandbox helper')?.ok, false);

  let windowsStatCalls = 0;
  const windows = cursorRuntimeDiagnostics('/workspace', diagnosticEnvironment({
    platform: 'win32',
    resolveSdkManifest(packageName) {
      assert.equal(packageName, '@cursor/sdk-win32-x64/package.json');
      return 'C:\\sdk\\package.json';
    },
    existsSync: (file) => file.endsWith('cursorsandbox.exe'),
    statMode() { windowsStatCalls += 1; return 0; },
  }));
  assert.equal(windows.find((item) => item.label === 'Cursor sandbox helper')?.ok, true);
  assert.match(windows.find((item) => item.label === 'Cursor sandbox helper')?.output ?? '', /cursorsandbox\.exe$/);
  assert.equal(windowsStatCalls, 0, 'Windows does not require a POSIX executable bit');

  const missingSdk = cursorRuntimeDiagnostics('/workspace', diagnosticEnvironment({
    resolveSdkManifest() { throw new Error('SDK is unavailable'); },
  }));
  assert.equal(missingSdk.find((item) => item.label === 'Cursor sandbox helper')?.ok, false);
  assert.match(missingSdk.find((item) => item.label === 'Cursor sandbox helper')?.output ?? '', /sandbox remains enabled/);
});
