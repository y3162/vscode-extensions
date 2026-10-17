import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { stdioLaunch, StdioJsonRpc } from '../../../src/providers/stdio-rpc.js';

interface FakeProc extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  writes: string[];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeProcess(): FakeProc {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), writes: [] as string[],
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      if (signal === 'SIGKILL') { this.signalCode = 'SIGKILL'; this.exitCode = null; proc.emit('exit', null, 'SIGKILL'); }
      return true;
    },
  }) as FakeProc;
  proc.stdin.on('data', (chunk) => proc.writes.push(String(chunk)));
  return proc;
}

function pushed(proc: FakeProc): unknown[] {
  return proc.writes.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

test('stdio launch selection handles script files and Windows shell requirements without changing the host platform', () => {
  assert.deepEqual(stdioLaunch({ command: '/workspace/agent.mjs', args: ['--json'] }, 'win32', 'C:\\Node\\node.exe'), {
    command: 'C:\\Node\\node.exe', args: ['/workspace/agent.mjs', '--json'], shell: false,
  });
  assert.deepEqual(stdioLaunch({ command: 'agent', args: ['--json'] }, 'win32', 'C:\\Node\\node.exe'), {
    command: 'agent', args: ['--json'], shell: true,
  });
  assert.deepEqual(stdioLaunch({ command: 'agent', args: ['--json'] }, 'linux', '/usr/bin/node'), {
    command: 'agent', args: ['--json'], shell: false,
  });
});

test('a closed stdin rejects the request and drops its abort listener', async () => {
  const proc = fakeProcess();
  const spawn = mock.method(childProcess, 'spawn', () => proc);
  try {
    const rpc = new StdioJsonRpc({ command: 'agent', args: ['acp'] });
    Object.defineProperty(proc.stdin, 'writable', { configurable: true, get: () => false });
    const signal = new AbortController();
    const removed: string[] = [];
    const original = signal.signal.removeEventListener.bind(signal.signal);
    signal.signal.removeEventListener = ((type: string, listener: (...args: unknown[]) => void, options?: unknown) => {
      removed.push(type);
      return original(type, listener, options as never);
    }) as typeof signal.signal.removeEventListener;
    await assert.rejects(rpc.request('ping', {}, signal.signal), /Agent process exited/);
    assert.deepEqual(removed, ['abort']);
    rpc.notify('session/cancel', { sessionId: 's' });
    assert.equal(proc.writes.length, 0);
    assert.equal(rpc.isClosed, false);
    proc.emit('error', 'plain failure');
    await assert.rejects(rpc.request('later', {}), /plain failure/);
    proc.emit('error', 'again');
    proc.emit('exit', null, 'SIGHUP');
    await assert.rejects(rpc.request('after', {}), /plain failure/);
    proc.exitCode = 0;
    await rpc.dispose();
  } finally { spawn.mock.restore(); }
});

test('a server handler rejection is written back and a stuck child is killed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = fakeProcess();
  const spawn = mock.method(childProcess, 'spawn', () => proc);
  try {
    const rpc = new StdioJsonRpc({ command: 'agent', args: [] });
    let failed = '';
    rpc.setHandlers({
      request: async () => { throw new Error('handler failed'); },
      notification: () => undefined,
      closed: (error) => { failed = error.message; },
    });
    proc.stdout.write(`${JSON.stringify({ id: 7, method: 'ask', params: { q: 1 } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pushed(proc)[0], { id: 7, error: { code: -32000, message: 'handler failed' } });
    proc.stdout.write('\n');
    proc.stdout.write(`${JSON.stringify({ method: 'notice', params: { n: 1 } })}\n`);
    proc.stderr.write('stderr only');
    const disposing = rpc.dispose();
    t.mock.timers.tick(1500);
    await disposing;
    assert.match(failed, /Agent process closed/);
    assert.equal(proc.signalCode, 'SIGKILL');
  } finally { spawn.mock.restore(); }
});

test('default JSON-RPC handlers ignore notifications and answer server requests with an empty object', async (t) => {
  const proc = fakeProcess();
  const spawn = mock.method(childProcess, 'spawn', () => proc);
  try {
    const rpc = new StdioJsonRpc({ command: 'agent', args: [] });
    rpc.notify('client/notice', { ready: true });
    proc.stdout.write(`${JSON.stringify({ method: 'server/notice', params: { ignored: true } })}\n`);
    proc.stdout.write(`${JSON.stringify({ id: 8, method: 'server/ask', params: { question: true } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pushed(proc), [
      { method: 'client/notice', params: { ready: true } },
      { id: 8, result: {} },
    ]);
    proc.exitCode = 0;
    await rpc.dispose();
  } finally { spawn.mock.restore(); }
});

test('a javascript fixture is spawned with the current node binary', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'stdio-rpc-cjs-'));
  const command = path.join(cwd, 'echo-rpc.cjs');
  await writeFile(command, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: { exec: process.execPath, script: process.argv[1], flag: process.argv[2] } }) + '\\n');
});
`);
  const rpc = new StdioJsonRpc({ command, args: ['--flag'], cwd });
  try {
    assert.deepEqual(await rpc.request('ping', {}), { exec: process.execPath, script: command, flag: '--flag' });
  } finally { await rpc.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
