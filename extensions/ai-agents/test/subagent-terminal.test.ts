import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import { CursorTerminals } from '../src/providers/cursor-terminals.js';
import { TerminalMonitor } from '../src/terminal-monitor.js';
import type { AgentUpdate, Selection } from '../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('duplicate child ids collapse and a parent stop does not complete the children', async () => {
  const entered = deferred();
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, signal, emit) {
      emit({ id: 'card-a', role: 'status', text: 'alpha', meta: { type: 'subagent', subagent: { id: 'alpha', name: 'alpha', status: 'running', background: false } } });
      emit({ id: 'card-b', role: 'status', text: 'beta', meta: { type: 'subagent', subagent: { id: 'beta', name: 'beta', status: 'running', background: true } } });
      emit({ id: 'card-a2', role: 'status', text: 'alpha again', meta: { type: 'subagent', subagent: { id: 'alpha', name: 'alpha', status: 'running', background: false } } });
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async dispose() {},
  }), () => {});
  const running = controller.send('go');
  await entered.promise;
  assert.deepEqual(controller.snapshot().subagents.map((child) => child.id), ['alpha', 'beta']);
  controller.stop();
  await running;
  assert.deepEqual(controller.snapshot().subagents.map((child) => [child.id, child.status]), [['alpha', 'running'], ['beta', 'running']]);
});

test('a terminal snapshot that is not a prefix redraws instead of appending a gap', async () => {
  let listener: ((update: AgentUpdate) => void) | undefined;
  const session = {
    async run() {}, async dispose() {},
    subscribeBackgroundUpdates(next: (update: AgentUpdate) => void) { listener = next; return () => {}; },
    async listBackgroundTerminals() { return []; },
  };
  let output = '';
  const monitor = new TerminalMonitor(session, { processId: 'p', itemId: 'i', command: 'job', output: 'old\n' }, (text) => { output += text; }, false);
  monitor.open();
  await new Promise((resolve) => setImmediate(resolve));
  listener?.({ id: 'i', role: 'tool', text: 'replaced\n', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  assert.match(output, /\x1b\[2J\x1b\[Hreplaced\r\n/);
  assert.equal(output.split('old').length - 1, 1);
  monitor.dispose();
});

test('Cursor terminal logs larger than 256KB keep the header and the tail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-terminal-log-'));
  try {
    const folder = path.join(root, 'projects', 'demo', 'terminals');
    await mkdir(folder, { recursive: true });
    const header = '---\npid: 4242\ncwd: /tmp\ncommand: "printf"\nstarted_at: 2026-01-01T00:00:00.000Z\nstatus: running\n---\n';
    await writeFile(path.join(folder, '1.txt'), `${header}${'A'.repeat(300 * 1024)}TAIL_MARKER`);
    const updates: AgentUpdate[] = [];
    const terminals = new CursorTerminals(root, (update) => updates.push(update), async () => true);
    const rows = await terminals.refresh();
    terminals.dispose();
    assert.equal(rows[0]?.command, 'printf');
    assert.match(rows[0]?.output ?? '', /Earlier output omitted/);
    assert.match(rows[0]?.output ?? '', /TAIL_MARKER/);
    assert.equal(updates.some((update) => update.meta?.type === 'terminals'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a background child update after the session is replaced stays off the new turn', async () => {
  let listener: ((update: AgentUpdate) => void) | undefined;
  const controller = new ChatController(selection, async () => ({
    async run(prompt, _signal, emit) {
      if (prompt === 'first') emit({ id: 'child', role: 'status', text: 'child', meta: { type: 'subagent', subagent: { id: 'child-1', name: 'child', status: 'running', background: true } } });
      else emit({ id: 'answer', role: 'assistant', text: 'second answer' });
    },
    subscribeBackgroundUpdates(next) { listener = next; return () => { listener = undefined; }; },
    async dispose() {},
  }), () => {});
  await controller.send('first');
  const saved = listener!;
  await controller.send('second');
  saved({ id: 'child', role: 'status', text: 'child', meta: { type: 'subagent', subagent: { id: 'child-1', name: 'child', status: 'completed', background: true } } });
  const child = controller.snapshot().subagents[0];
  assert.equal(child?.status, 'completed');
  assert.equal(child?.parentTurnId, controller.snapshot().turns[0]?.id);
  assert.notEqual(child?.parentTurnId, controller.snapshot().turns[1]?.id);
});
