import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalMonitor } from '../src/terminal-monitor.js';
import type { AgentSession, AgentUpdate } from '../src/types.js';

test('terminal mirror streams snapshots once, keeps the original process and detaches without stopping it', async () => {
  let listener: ((update: AgentUpdate) => void) | undefined;
  let interrupted = '';
  let unsubscribe = 0;
  let terminate = 0;
  let run = 0;
  const row = { processId: 'p1', itemId: 'i1', command: 'sleep 120', output: 'first\n' };
  const session: AgentSession = {
    async run() { run++; }, async dispose() {},
    async listBackgroundTerminals() { return [row]; },
    async interruptBackgroundTerminal(id) { interrupted = id; },
    async terminateBackgroundTerminal() { terminate++; },
    subscribeBackgroundUpdates(next) { listener = next; return () => { listener = undefined; unsubscribe++; }; },
  };
  let output = '';
  const monitor = new TerminalMonitor(session, row, (text) => { output += text; }, false);
  monitor.open();
  await new Promise((resolve) => setImmediate(resolve));
  listener!({ id: 'unrelated', role: 'tool', text: 'wrong', tool: { name: 'shell', kind: 'shell', status: 'completed' } });
  listener!({ id: 'i1', role: 'tool', text: 'sleep 120\nfirst\nsecond\n', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  assert.equal(output.split('first').length - 1, 1);
  assert.match(output, /first\r\nsecond\r\n/);
  assert.doesNotMatch(output, /wrong/);
  monitor.handleInput('do not run this\r');
  monitor.handleInput('\x03');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupted, 'p1');
  assert.match(output, /\^C/);
  listener!({ id: 'i1', role: 'tool', text: 'sleep 120\nfirst\nsecond\ninterrupted\n', tool: { name: 'shell', kind: 'shell', status: 'completed', exitCode: 130 } });
  listener!({ id: 'terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: [] } });
  assert.equal(output.split('Process exited').length - 1, 1);
  assert.match(output, /130/);
  monitor.dispose();
  assert.equal(unsubscribe, 1);
  assert.equal(run, 0);
  assert.equal(terminate, 0);
});

test('a failed interrupt is visible, and closing before the async list returns discards late output', async () => {
  let resolve!: (value: []) => void;
  const session: AgentSession = {
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => new Promise<[]>((done) => { resolve = done; }),
    async interruptBackgroundTerminal() { throw new Error('permission denied'); },
  };
  let output = '';
  const monitor = new TerminalMonitor(session, { processId: 'p' }, (text) => { output += text; }, false);
  monitor.open(); monitor.handleInput('\x03');
  await new Promise((done) => setImmediate(done));
  assert.match(output, /permission denied/);
  monitor.dispose(); const previous = output;
  resolve([]); await new Promise((done) => setImmediate(done));
  assert.equal(output, previous);
});

test('a delayed list snapshot cannot overwrite newer streamed output or mistake a list error for exit', async () => {
  let listener!: (update: AgentUpdate) => void;
  const row = { processId: 'p', itemId: 'i', output: 'old\n' };
  let resolve!: (value: typeof row[]) => void;
  const session: AgentSession = {
    async run() {}, async dispose() {},
    subscribeBackgroundUpdates(next) { listener = next; return () => {}; },
    listBackgroundTerminals: () => new Promise((done) => { resolve = done; }),
  };
  let output = '';
  const monitor = new TerminalMonitor(session, row, (text) => { output += text; }, false);
  monitor.open();
  listener({ id: 'i', role: 'tool', text: 'old\nnew\n', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  resolve([row]); await new Promise((done) => setImmediate(done));
  assert.match(output, /old\r\nnew\r\n/);
  assert.doesNotMatch(output, /\x1b\[2J/);
  listener({ id: 'terminals', role: 'status', text: '', meta: { type: 'terminals', terminals: [], terminalError: 'unavailable' } });
  assert.doesNotMatch(output, /Process exited/);
  monitor.dispose();
});
