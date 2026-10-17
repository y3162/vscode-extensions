import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CursorTerminals, parseCursorTerminal } from '../../../src/providers/cursor-terminals.js';
import type { AgentUpdate } from '../../../src/types.js';

const log = (status = 'running', output = 'READY\n') => `---\npid: 12345\ncwd: "/workspace"\ncommand: "sleep 120"\nstatus: ${status.padEnd(9)}\nstarted_at: 2026-10-17T00:48:02.596Z\nrunning_for_ms: 1246\n---\n${output}`;

test('SDK terminal records preserve actual cancellation instead of inferring running from assistant text', () => {
  assert.equal(parseCursorTerminal('1', log())?.status, 'running');
  const cancelled = parseCursorTerminal('1', log('aborted', '\n---\nexit_code: unknown\nended_at: 2026-10-17T00:48:03.841Z\n---\n'));
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.command, 'sleep 120');
  assert.equal(parseCursorTerminal('1', '---\npid: 5\n'), undefined);
  assert.equal(parseCursorTerminal('1', '---\npid: 5\nactive_command: zsh\n---\ntext'), undefined);
});

test('terminal exit footers accept CRLF and a footer at the start of empty command output', () => {
  const footer = '---\nexit_code: 17\nended_at: 2026-10-17T00:48:03.841Z\n---\n';
  assert.equal(parseCursorTerminal('1', log('failed', footer))?.exitCode, 17);
  assert.equal(parseCursorTerminal('1', log('failed', footer).replace(/\n/g, '\r\n'))?.exitCode, 17);
});

test('isolated SDK terminal logs stream output and keep a finished terminal visible after the turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminals-'));
  const own = path.join(root, 'own'); const other = path.join(root, 'other');
  const folder = (base: string) => path.join(base, 'projects', 'workspace', 'terminals');
  const updates: AgentUpdate[] = [];
  const monitor = new CursorTerminals(own, (update) => updates.push(update), async () => true);
  try {
    await mkdir(folder(own), { recursive: true }); await mkdir(folder(other), { recursive: true });
    await writeFile(path.join(folder(other), '999.txt'), log());
    assert.deepEqual(await monitor.refresh(), []);
    await writeFile(path.join(folder(own), '123.txt'), log());
    assert.equal((await monitor.refresh())[0]?.status, 'running');
    assert.match(updates.at(-1)?.meta?.terminals?.[0]?.output ?? '', /READY/);
    await writeFile(path.join(folder(own), '123.txt'), log('succeeded', 'READY\nDONE\n\n---\nexit_code: 0\n---\n'));
    const rows = await monitor.refresh();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'completed');
    assert.equal(rows[0]?.exitCode, 0);
    assert.match(rows[0]?.output ?? '', /DONE/);
    await assert.rejects(monitor.interrupt(rows[0]!.processId), /終了/);
    const count = updates.length; await monitor.refresh();
    assert.equal(updates.length, count, 'unchanged snapshots do not create duplicate updates');
    await assert.rejects(monitor.interrupt('999.txt'), /終了/);
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a shared Cursor directory never claims or interrupts another worker terminal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-terminal-owner-'));
  const folder = path.join(root, 'projects', 'workspace', 'terminals');
  const updates: AgentUpdate[] = [];
  let interrupts = 0;
  const monitor = new CursorTerminals(root, (update) => updates.push(update), async () => false, '/workspace', () => { interrupts++; return true; });
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, '42.txt'), log());
    assert.deepEqual(await monitor.refresh(), []);
    await assert.rejects(monitor.interrupt('workspace/42.txt'), /終了/);
    assert.equal(interrupts, 0);
    assert.ok(updates.every((update) => !update.meta?.terminals?.length));
  } finally { monitor.dispose(); await rm(root, { recursive: true, force: true }); }
});
