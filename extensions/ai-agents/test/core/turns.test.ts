import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTurns, workElapsedMs } from '../../src/webview/turns.js';
import type { ViewMessage } from '../../src/protocol.js';

const read: ViewMessage = {
  id: 'tool', role: 'tool', text: 'completed: Read src/a.ts',
  tool: { kind: 'read', name: 'Read', status: 'completed', target: 'src/a.ts' },
};

test('a finished turn keeps the answer outside the collapsed work log', () => {
  const turns = buildTurns([
    { id: 'user', role: 'user', text: 'Fix it', at: 1_000 },
    read,
    { id: 'read-2', role: 'tool', text: 'completed: Read src/b.ts', tool: { kind: 'read', name: 'Read', status: 'completed', target: 'src/b.ts' } },
    { id: 'answer', role: 'assistant', text: 'Done', at: 4_000 },
  ], false, false);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.done, true);
  assert.equal(turns[0]?.answer?.text, 'Done');
  assert.equal(turns[0]?.log[0]?.type, 'explore');
  assert.equal(turns[0]?.log[0]?.type === 'explore' ? turns[0].log[0].tools.length : 0, 2);
  assert.equal(turns[0]?.log.some((segment) => segment.type === 'text'), false);
  const running = buildTurns([{ id: 'user', role: 'user', text: 'Go', at: 1 }, read], true, false);
  assert.equal(running[0]?.done, false);
  assert.equal(running[0]?.answer, undefined);
});

test('consecutive shell and edit calls become separate groups and keep their tools', () => {
  const turns = buildTurns([
    { id: 'user', role: 'user', text: 'Do both', at: 1 },
    { id: 'sh-1', role: 'tool', text: 'completed: npm test\nok', tool: { kind: 'shell', name: 'command', status: 'completed', target: 'npm test', exitCode: 0 } },
    { id: 'sh-2', role: 'tool', text: 'failed: npm run lint\nerror', tool: { kind: 'shell', name: 'command', status: 'error', target: 'npm run lint', exitCode: 1 } },
    { id: 'read', role: 'tool', text: 'completed: Read src/a.ts', tool: { kind: 'read', name: 'Read', status: 'completed', target: 'src/a.ts' } },
    { id: 'ed-1', role: 'tool', text: 'edited a', tool: { kind: 'edit', name: 'Edit', status: 'completed', target: 'src/a.ts' } },
    { id: 'ed-2', role: 'tool', text: 'edited b', tool: { kind: 'edit', name: 'Edit', status: 'completed', target: 'src/b.ts' } },
  ], false, false);
  const log = turns[0]?.log ?? [];
  assert.deepEqual(log.map((segment) => segment.type), ['ran', 'explore', 'edited']);
  const ran = log[0];
  const edited = log[2];
  assert.equal(ran?.type === 'ran' ? ran.tools.length : 0, 2);
  assert.equal(ran?.type === 'ran' ? ran.tools[1]?.exitCode : undefined, 1);
  assert.equal(ran?.type === 'ran' ? ran.tools[1]?.detail.includes('error') : false, true);
  assert.equal(edited?.type === 'edited' ? edited.tools.map((tool) => tool.target).join(',') : '', 'src/a.ts,src/b.ts');
});

test('blank thinking is dropped and work time is omitted when the span is missing or under 1ms', () => {
  const blank = buildTurns([
    { id: 'user', role: 'user', text: 'Think', at: 10 },
    { id: 'thought', role: 'status', text: '   \n', at: 11, meta: { type: 'thinking' } },
    { id: 'answer', role: 'assistant', text: 'Done', at: 12, final: true },
  ], false, false);
  assert.equal(blank[0]?.log.some((segment) => segment.type === 'thinking'), false);
  assert.equal(workElapsedMs({ startedAt: 10, endedAt: undefined, status: 'completed' }), undefined);
  assert.equal(workElapsedMs({ startedAt: 10, endedAt: 10, status: 'completed' }), undefined);
  assert.equal(workElapsedMs({ startedAt: 10, endedAt: 11, status: 'completed' }), 1);
  assert.equal(workElapsedMs({ startedAt: 10, endedAt: 40, status: 'unknown' }), undefined);
  assert.equal(workElapsedMs({ startedAt: 10, endedAt: 40, status: 'cancelled' }), 30);
});

test('adjacent file updates collapse to one latest card per path', () => {
  const turns = buildTurns([
    { id: 'user', role: 'user', text: 'Update files', at: 1 },
    { id: 'file-a1', role: 'tool', text: 'update a', meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', additions: 2, deletions: 1, preview: [{ kind: 'add', line: 1, text: 'intermediate' }] }] } },
    { id: 'file-b', role: 'tool', text: 'update b', meta: { type: 'files', files: [{ path: 'src/b.ts', kind: 'add', additions: 1, preview: [{ kind: 'add', line: 1, text: 'b' }] }] } },
    { id: 'file-a2', role: 'tool', text: 'update a again', meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', additions: 4, deletions: 3, preview: [{ kind: 'remove', line: 1, text: 'before' }, { kind: 'add', line: 1, text: 'after' }] }] } },
  ], false, false);
  const files = turns[0]?.log.find((segment) => segment.type === 'files');
  assert.equal(files?.type, 'files');
  if (files?.type !== 'files') return;
  assert.deepEqual(files.files.map((file) => file.path), ['README.md', 'src/b.ts']);
  assert.equal(files.files[0]?.additions, 4);
  assert.equal(files.files[0]?.deletions, 3);
  assert.deepEqual(files.files[0]?.preview?.map((line) => line.text), ['before', 'after']);
});
