import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTurns } from '../src/webview/turns.js';
import type { ViewMessage } from '../src/protocol.js';

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
  assert.equal(turns[0]?.log[0]?.type, 'tools');
  assert.equal(turns[0]?.log[0]?.type === 'tools' ? turns[0].log[0].tools.length : 0, 2);
  const running = buildTurns([{ id: 'user', role: 'user', text: 'Go', at: 1 }, read], true, false);
  assert.equal(running[0]?.done, false);
  assert.equal(running[0]?.answer, undefined);
});
