import assert from 'node:assert/strict';

import { test } from 'node:test';

import { TerminalMonitor } from '../../src/terminal-monitor.js';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('terminal mirror covers Japanese text, list races, redraws, and duplicate errors', async () => {
  const writes: string[] = [];
  let listed!: (rows: { processId: string; status?: string; output?: string; exitCode?: number; error?: string }[]) => void;
  const pending = new Promise<{ processId: string; status?: string; output?: string; exitCode?: number }[]>((resolve) => { listed = resolve; });
  let listener: ((update: import('../../src/types.js').AgentUpdate) => void) | undefined;
  const session = {
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => pending,
    subscribeBackgroundUpdates(next: (update: import('../../src/types.js').AgentUpdate) => void) { listener = next; return () => { listener = undefined; }; },
  };
  const monitor = new TerminalMonitor(session, { processId: 'p', itemId: 'item', command: 'job', output: 'old\r\n' }, (text) => writes.push(text), true);
  monitor.open();
  monitor.open();
  assert.equal(writes.filter((text) => text.includes('既存のバックグラウンド')).length, 1);
  listener?.({ id: 'item', role: 'tool', text: 'job', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  listener?.({ id: 'item', role: 'tool', text: 'replaced', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  assert.equal(writes.some((text) => text.includes('\x1b[2J')), true);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  listed([{ processId: 'p', status: 'complete', output: 'late', exitCode: 0 }]);
  await pending;
  await flushMicrotasks();
  assert.equal(writes.some((text) => text.includes('プロセス終了')), false);
  listener?.({ id: 'terms', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', error: 'disk full', status: 'running' }] } });
  listener?.({ id: 'terms', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', error: 'disk full', status: 'running' }] } });
  assert.equal(writes.filter((text) => text.includes('disk full')).length, 1);
  listener?.({ id: 'terms-2', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', status: 'complete', exitCode: 3, output: 'replaced\r\n' }] } });
  assert.equal(writes.some((text) => text.includes('プロセス終了: 3')), true);
  monitor.handleInput('plain');
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  monitor.dispose();
  const before = writes.length;
  listener?.({ id: 'item', role: 'tool', text: 'after close', tool: { name: 'shell', kind: 'shell', status: 'completed' } });
  monitor.open();
  assert.equal(writes.length, before);
});

test('a background list error is not an exit, and a missing row finishes the mirror', async () => {
  let rejectList!: (error: unknown) => void;
  const failing = new Promise<never>((_resolve, reject) => { rejectList = reject; });
  const output: string[] = [];
  const monitor = new TerminalMonitor({
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => failing,
  }, { processId: 'p' }, (text) => output.push(text), false);
  monitor.open();
  rejectList(new Error('list failed'));
  await flushMicrotasks();
  assert.equal(output.some((text) => text.includes('list failed')), true);
  assert.equal(output.some((text) => text.includes('Process exited')), false);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(output.filter((text) => text.includes('does not support interrupting')).length, 1);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(output.filter((text) => text.includes('does not support interrupting')).length, 1);
  monitor.dispose();
  let resolveRows!: (rows: []) => void;
  const rows = new Promise<[]>((resolve) => { resolveRows = resolve; });
  const second: string[] = [];
  const finished = new TerminalMonitor({
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => rows,
    async interruptBackgroundTerminal() { throw 'boom'; },
  }, { processId: 'gone', command: 'sleep' }, (text) => second.push(text), false);
  finished.open();
  finished.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(second.filter((text) => text.includes('boom')).length, 1);
  finished.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(second.filter((text) => text.includes('boom')).length, 1);
  resolveRows([]);
  await rows;
  await flushMicrotasks();
  assert.equal(second.some((text) => text.includes('Process exited')), true);
  const listed: string[] = [];
  const completed = new TerminalMonitor({
    async run() {}, async dispose() {},
    async listBackgroundTerminals() { return [{ processId: 'p', status: 'complete', exitCode: 0, output: 'done\n' }]; },
  }, { processId: 'p', output: '' }, (text) => listed.push(text), false);
  completed.open();
  await flushMicrotasks();
  assert.equal(listed.some((text) => text.includes('Process exited: 0')), true);
  assert.equal(listed.some((text) => text.includes('done')), true);
});;;
