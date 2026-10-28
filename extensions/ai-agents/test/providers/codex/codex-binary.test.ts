import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentLaunch, codexLaunch, codexSpawn } from '../../../src/providers/codex-binary.js';

const fs = createRequire(__filename)('node:fs') as typeof import('node:fs');

test('an explicit Codex path is launched as given and an API key is added to the environment', () => {
  const keyed = codexLaunch('/usr/local/bin/codex', ['app-server'], '/work', 'test-key');
  assert.equal(keyed.kind, 'override');
  assert.equal(keyed.command, '/usr/local/bin/codex');
  assert.deepEqual(keyed.args, ['app-server']);
  assert.equal(keyed.cwd, '/work');
  assert.equal(keyed.env?.CODEX_API_KEY, 'test-key');
  assert.equal(keyed.env?.PATH, process.env.PATH);
  const plain = codexSpawn('/bin/codex', [], undefined, undefined);
  assert.equal(plain.env?.CODEX_API_KEY, process.env.CODEX_API_KEY);
});

test('the bundled Codex entry reports its package version and runs under the current Node', () => {
  const launch = codexLaunch(undefined, ['--version'], '/repo');
  assert.equal(launch.kind, 'bundled');
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.cwd, '/repo');
  assert.equal(launch.env?.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launch.args[0]?.endsWith('codex.js'), true);
  assert.match(launch.version ?? '', /^\d+\.\d+\.\d+/);
  assert.equal(launch.args.slice(1).join(' '), '--version');
});

test('a missing or empty bundled manifest version stays unknown', (t) => {
  t.mock.method(fs, 'readFileSync', () => { throw new Error('missing manifest'); });
  assert.equal(codexLaunch(undefined, []).version, 'unknown');
  t.mock.method(fs, 'readFileSync', () => JSON.stringify({ name: 'codex' }));
  assert.equal(codexLaunch(undefined, []).version, 'unknown');
});

test('agent launch distinguishes a PATH command from an explicit path', () => {
  assert.deepEqual(agentLaunch(undefined, ['acp'], '/work'), { kind: 'path', command: 'agent', args: ['acp'], cwd: '/work' });
  assert.equal(agentLaunch('agent', []).kind, 'path');
  assert.equal(agentLaunch('/opt/agent', []).kind, 'override');
  assert.equal(agentLaunch('C:\\Tools\\agent.exe', []).kind, 'override');
});

test('agent launch finds the standard Cursor installation when PATH does not contain it', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-path-'));
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  try {
    const bin = path.join(root, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const agent = path.join(bin, 'agent');
    writeFileSync(agent, '#!/bin/sh\n');
    chmodSync(agent, 0o755);
    process.env.HOME = root;
    process.env.PATH = '/nonexistent';
    assert.equal(agentLaunch('agent', []).command, agent);
    process.env.PATH = bin;
    assert.equal(agentLaunch('agent', []).command, 'agent');
    assert.equal(agentLaunch('/custom/agent', []).command, '/custom/agent');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
