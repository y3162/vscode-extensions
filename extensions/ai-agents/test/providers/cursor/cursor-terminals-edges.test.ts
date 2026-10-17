import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CursorTerminals, ownsProcess, parentPidFromPs, parseCursorTerminal } from '../../../src/providers/cursor-terminals.js';
import type { AgentUpdate } from '../../../src/types.js';

const started = '2026-10-17T00:48:02.596Z';
const later = '2026-10-17T00:49:02.596Z';

function log(options: { status?: string; pid?: string; startedAt?: string; command?: string; output?: string } = {}): string {
  const command = options.command ?? '"sleep 120"';
  return `---\npid: ${options.pid ?? '12345'}\ncommand: ${command}\nstatus: ${options.status ?? 'running'}\nstarted_at: ${options.startedAt ?? started}\n---\n${options.output ?? 'READY\n'}`;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function tree(): Promise<{ root: string; folder: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-edges-'));
  const folder = path.join(root, 'projects', 'workspace', 'terminals');
  await mkdir(folder, { recursive: true });
  return { root, folder };
}

test('parse rejects incomplete headers and keeps only a real process id', () => {
  assert.equal(parseCursorTerminal('1', log({ command: '12' })), undefined);
  assert.equal(parseCursorTerminal('1', log({ command: 'sleep' })), undefined);
  assert.equal(parseCursorTerminal('1', log({ command: '{"a":1}' })), undefined);
  assert.equal(parseCursorTerminal('1', log({ startedAt: 'yesterday' })), undefined);
  assert.equal(parseCursorTerminal('1', log({ status: 'mystery' }))?.status, 'unknown');
  assert.equal(parseCursorTerminal('1', log({ pid: '1' }))?.pid, undefined);
  assert.equal(parseCursorTerminal('1', log({ pid: '0' }))?.pid, undefined);
  assert.equal(parseCursorTerminal('1', log({ pid: '1.5' }))?.pid, undefined);
  assert.equal(parseCursorTerminal('1', log({ status: 'failed', output: '---\nexit_code: -1\n' }))?.exitCode, -1);
  assert.equal(parseCursorTerminal('1', '---\nno-colon\ncommand: "ok"\nstarted_at: 2026-10-17T00:48:02.596Z\n---\n')?.command, 'ok');
});

test('ownsProcess recognizes this process, a stranger, a reader failure, the depth limit, and pid 1', async () => {
  assert.equal(await ownsProcess(40, async (pid) => pid === 40 ? process.pid : 1), true);
  assert.equal(await ownsProcess(10, async (pid) => pid === 10 ? 11 : process.pid), true);
  assert.equal(await ownsProcess(40, async () => 424242), false);
  assert.equal(await ownsProcess(10, async () => 1), false);
  assert.equal(await ownsProcess(10, async () => Number.NaN), false);
  assert.equal(await ownsProcess(40, async () => { throw new Error('ps failed'); }), false);
  let reads = 0;
  assert.equal(await ownsProcess(3, async (pid) => { reads += 1; return pid + 1; }), false);
  assert.equal(reads, 20);
  reads = 0;
  assert.equal(await ownsProcess(1, async () => { reads += 1; return process.pid; }), false);
  assert.equal(await ownsProcess(0, async () => { reads += 1; return process.pid; }), false);
  assert.equal(reads, 0);
  assert.equal(await ownsProcess(Number.MAX_SAFE_INTEGER), false);
  assert.equal(typeof await ownsProcess(process.pid), 'boolean');
});

test('parent PID lookup builds the ps request, parses synthetic output, and preserves command errors', async () => {
  const calls: Array<[string, string[]]> = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, args]);
    return { stdout: ' 42\n' };
  };
  assert.equal(await parentPidFromPs(1234, run), 42);
  assert.deepEqual(calls, [['/bin/ps', ['-o', 'ppid=', '-p', '1234']]]);
  assert.equal(Number.isNaN(await parentPidFromPs(1234, async () => ({ stdout: 'not-a-pid' }))), true);
  await assert.rejects(parentPidFromPs(1234, async () => { throw new Error('synthetic ps failure'); }), /synthetic ps failure/);
});

test('interrupt signals only the owned process group and falls back after ESRCH', async (t) => {
  const { root, folder } = await tree();
  const calls: number[] = [];
  t.mock.method(process, 'kill', (pid: number) => {
    calls.push(pid);
    if (pid < 0) throw errno('ESRCH');
    return true;
  });
  const monitor = new CursorTerminals(root, () => {}, async () => true);
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    const [row] = await monitor.refresh();
    await monitor.interrupt(row!.processId);
    assert.deepEqual(calls, [-12345, 12345]);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a non-ESRCH signal error is rethrown without signalling another pid', async (t) => {
  const { root, folder } = await tree();
  const calls: number[] = [];
  t.mock.method(process, 'kill', (pid: number) => {
    calls.push(pid);
    if (pid < 0) throw errno('EPERM');
    throw new Error('unrelated process');
  });
  const monitor = new CursorTerminals(root, () => {}, async () => true);
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    const [row] = await monitor.refresh();
    await assert.rejects(monitor.interrupt(row!.processId), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
    assert.deepEqual(calls, [-12345]);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('an injected signal is used for success, ESRCH fallback, and unrelated refusal', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  const calls: Array<[number, string | number | undefined]> = [];
  const signal = (pid: number, value?: NodeJS.Signals | number) => {
    calls.push([pid, value]);
    return true;
  };
  let owns = true;
  let native: boolean | undefined;
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => owns, undefined, (shellId, pid) => {
    assert.equal(shellId, 123);
    assert.equal(pid, 12345);
    return native === true;
  }, signal);
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    const id = (await monitor.refresh())[0]!.processId;
    native = true;
    await monitor.interrupt(id);
    assert.deepEqual(calls, []);
    native = false;
    await monitor.interrupt(id);
    assert.deepEqual(calls, [[-12345, 'SIGINT']]);
    calls.length = 0;
    owns = false;
    await assert.rejects(monitor.interrupt(id), /所属/);
    assert.deepEqual(calls, []);
    const refused: number[] = [];
    const blocked = new CursorTerminals(root, () => {}, async () => true, undefined, undefined, (pid) => {
      refused.push(pid);
      if (pid < 0) throw errno('EPERM');
      throw new Error('unrelated');
    });
    await assert.rejects(blocked.interrupt(id), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
    assert.deepEqual(refused, [-12345]);
    blocked.dispose();
    assert.ok(updates.some((update) => update.tool?.status === 'running'));
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('an unsafe shell id skips native interrupt and still signals the owned pid', async () => {
  const { root, folder } = await tree();
  const name = '9007199254740993.txt';
  let nativeCalls = 0;
  const calls: number[] = [];
  const monitor = new CursorTerminals(root, () => {}, async () => true, undefined, () => { nativeCalls += 1; return true; }, (pid) => {
    calls.push(pid);
    return true;
  });
  try {
    await writeFile(path.join(folder, name), log());
    const [row] = await monitor.refresh();
    await monitor.interrupt(row!.processId);
    assert.equal(nativeCalls, 0);
    assert.deepEqual(calls, [-12345]);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('scan skips unrelated files, foreign workspaces, and terminals this worker does not own', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  let ownsCalls = 0;
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => { ownsCalls += 1; return false; }, '//Foo__Bar');
  const elsewhere = path.join(root, 'projects', 'elsewhere', 'terminals');
  const matched = path.join(root, 'projects', 'Foo-Bar', 'terminals');
  try {
    await mkdir(elsewhere, { recursive: true });
    await mkdir(matched, { recursive: true });
    await writeFile(path.join(root, 'projects', 'notes'), 'not a directory');
    await writeFile(path.join(folder, 'notes.txt'), log());
    await mkdir(path.join(folder, '12.txt'));
    await writeFile(path.join(folder, '13.txt'), '---\npid: 5\n');
    await writeFile(path.join(elsewhere, '14.txt'), log());
    await writeFile(path.join(matched, '15.txt'), log({ status: 'succeeded' }));
    await writeFile(path.join(matched, '16.txt'), log({ pid: '1' }));
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(ownsCalls, 0);
    await writeFile(path.join(matched, '17.txt'), log());
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(ownsCalls, 1);
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(ownsCalls, 1, 'a rejected identity is not claimed again');
    assert.ok(updates.every((update) => update.meta?.type !== 'terminals' || !update.meta.terminals?.length));
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a missing projects directory is empty and a non-directory projects path reports the error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-missing-'));
  const updates: AgentUpdate[] = [];
  const monitor = new CursorTerminals(root, (update) => updates.push(update));
  try {
    assert.deepEqual(await monitor.refresh(), []);
    await writeFile(path.join(root, 'projects'), 'not a directory');
    await assert.rejects(monitor.refresh(), (error: NodeJS.ErrnoException) => error.code === 'ENOTDIR');
    assert.match(updates.at(-1)?.meta?.terminalError ?? '', /ENOTDIR|not a directory/);
    assert.deepEqual(updates.at(-1)?.meta?.terminals, []);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a terminals folder removed between lstat and readdir is treated as a normal exit race', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  let removed = false;
  const readDirectory = async (directory: string, options: { withFileTypes: true }) => {
    if (directory === folder && !removed) {
      removed = true;
      await rm(folder, { recursive: true, force: true });
    }
    return readdir(directory, options);
  };
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => true, undefined, undefined, process.kill, readDirectory);
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    assert.deepEqual(await monitor.refresh(), []);
    assert.equal(removed, true, 'the injected directory reader removed the folder after lstat observed it');
    assert.equal(updates.some((update) => Boolean(update.meta?.terminalError)), false);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a terminal-folder read error other than ENOENT remains visible and fails closed', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  const readDirectory = async (directory: string, options: { withFileTypes: true }) => {
    if (directory === folder) throw Object.assign(new Error('terminal folder unreadable'), { code: 'EACCES' });
    return readdir(directory, options);
  };
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => true, undefined, undefined, process.kill, readDirectory);
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    await assert.rejects(monitor.refresh(), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
    assert.equal(updates.at(-1)?.meta?.terminalError, 'terminal folder unreadable');
    assert.deepEqual(updates.at(-1)?.meta?.terminals, []);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a vanished terminals directory is skipped and an unreadable workspace surfaces', async () => {
  const { root, folder } = await tree();
  const workspace = path.join(root, 'projects', 'workspace');
  const monitor = new CursorTerminals(root, () => {});
  try {
    await rm(folder, { recursive: true, force: true });
    assert.deepEqual(await monitor.refresh(), []);
    await chmod(workspace, 0);
    const blocked = new CursorTerminals(root, () => {});
    await assert.rejects(blocked.refresh(), (error: NodeJS.ErrnoException) => error.code === 'EACCES' || error.code === 'EPERM');
    blocked.dispose();
  } finally {
    await chmod(workspace, 0o755).catch(() => undefined);
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-error scan failure is reported as text and disposal suppresses a late failure', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  let release!: (value: boolean) => void;
  let arrived!: () => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const arrivedPromise = new Promise<void>((resolve) => { arrived = resolve; });
  const monitor = new CursorTerminals(root, (update) => updates.push(update), () => { arrived(); return gate; });
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    const pending = monitor.refresh();
    await arrivedPromise;
    monitor.dispose();
    release(true);
    assert.deepEqual(await pending, []);
    assert.equal(updates.length, 0);
    const stringError = new CursorTerminals(root, (update) => updates.push(update), async () => { throw 'disk'; });
    await assert.rejects(stringError.refresh(), (error) => error === 'disk');
    assert.equal(updates.at(-1)?.meta?.terminalError, 'disk');
    stringError.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a terminal update callback failure leaves the row unclaimed and the next refresh recovers', async () => {
  const { root, folder } = await tree();
  let failToolUpdate = true;
  let ownershipChecks = 0;
  const attemptedTools: AgentUpdate[] = [];
  const deliveredTools: AgentUpdate[] = [];
  const errors: string[] = [];
  const monitor = new CursorTerminals(root, (update) => {
    if (update.tool?.name === 'shell') {
      attemptedTools.push(update);
      if (failToolUpdate) {
        failToolUpdate = false;
        throw new Error('terminal subscriber failed');
      }
      deliveredTools.push(update);
    }
    if (update.meta?.terminalError) errors.push(update.meta.terminalError);
  }, async () => { ownershipChecks += 1; return true; });
  try {
    await writeFile(path.join(folder, '123.txt'), log());
    await assert.rejects(monitor.refresh(), /terminal subscriber failed/);
    assert.equal(attemptedTools.length, 1, 'the first row update reaches the failing listener');
    assert.deepEqual(errors, ['terminal subscriber failed']);

    const recovered = await monitor.refresh();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.processId, 'workspace/123.txt');
    assert.equal(ownershipChecks, 2, 'the failed callback did not mark the process as claimed');
    assert.equal(deliveredTools.length, 1);
    assert.equal(deliveredTools[0]?.id, 'cursor-terminal:workspace/123.txt');

    assert.equal((await monitor.refresh()).length, 1);
    assert.equal(deliveredTools.length, 1, 'a recovered row is not emitted again when unchanged');
    assert.equal(ownershipChecks, 2, 'a successfully claimed process is not rechecked');
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('large logs keep the tail and a changed identity is not reclaimed', async () => {
  const { root, folder } = await tree();
  const updates: AgentUpdate[] = [];
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => true);
  try {
    const header = `---\npid: 12345\ncommand: "sleep 120"\nstatus: running\nstarted_at: ${started}\n---\n`;
    await writeFile(path.join(folder, '123.txt'), header + 'x'.repeat(300 * 1024) + '\nTAIL_MARKER\n');
    const row = (await monitor.refresh())[0];
    assert.match(row?.output ?? '', /Earlier output omitted/);
    assert.match(row?.output ?? '', /TAIL_MARKER/);
    await writeFile(path.join(folder, '124.txt'), `---\n${'p'.repeat(300 * 1024)}\n---\noutput\n`);
    assert.equal((await monitor.refresh()).some((item) => item.processId.endsWith('124.txt')), false);
    await writeFile(path.join(folder, '123.txt'), log({ pid: '99', startedAt: later, status: 'failed', output: '---\nexit_code: 2\n' }));
    const retained = await monitor.refresh();
    const retainedIdentity = retained[0] as (typeof retained)[number] & { pid?: number; startedAt?: string };
    assert.equal(retainedIdentity.pid, 12345);
    assert.equal(retainedIdentity.startedAt, started);
    await writeFile(path.join(folder, '123.txt'), log({ status: 'unknown' }));
    const unknown = (await monitor.refresh())[0];
    assert.equal(unknown?.status, 'unknown');
    assert.equal(updates.find((update) => update.tool && update.id === unknown?.itemId)?.tool?.status, 'running');
    await writeFile(path.join(folder, '123.txt'), log({ status: 'failed', output: '---\nexit_code: 2\n' }));
    const failed = (await monitor.refresh())[0];
    assert.equal(failed?.status, 'failed');
    const finalTool = updates.filter((update) => update.tool).at(-1)?.tool;
    assert.equal(finalTool?.status, 'error');
    assert.equal(finalTool?.exitCode, 2);
    const fileTerminals = path.join(root, 'projects', 'workspace', 'not-terminals');
    await mkdir(path.join(root, 'projects', 'plain'));
    await writeFile(path.join(root, 'projects', 'plain', 'terminals'), 'file');
    assert.equal(await lstat(fileTerminals).then(() => false, () => true), true);
    assert.equal((await monitor.refresh()).length, 1);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('polling starts, finishRun stops it, and dispose drops a pending timer', async () => {
  const { root, folder } = await tree();
  let terminals = 0;
  let seen!: () => void;
  const ready = new Promise<void>((resolve) => { seen = resolve; });
  const monitor = new CursorTerminals(root, (update) => {
    if (update.meta?.type === 'terminals') { terminals += 1; seen(); }
  }, async () => true);
  try {
    monitor.start();
    monitor.start();
    await ready;
    assert.equal(terminals, 1);
    await writeFile(path.join(folder, '123.txt'), log());
    await monitor.finishRun();
    assert.equal(terminals >= 2, true);
    const count = terminals;
    monitor.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminals, count);
    assert.deepEqual(await monitor.refresh(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
