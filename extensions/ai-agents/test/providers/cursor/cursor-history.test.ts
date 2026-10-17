import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorStoredMessages } from '../../../src/providers/cursor-history.js';

test('stored Cursor turns keep the latest assistant final and skip steps that are not messages', () => {
  const messages = cursorStoredMessages([
    { uuid: 'row-1', message: { agentConversationTurn: { userMessage: { text: 'Hi', startedAtMs: 50 }, steps: [
      { assistantMessage: { text: 'A' } },
      { thinkingMessage: { text: 'think' } },
      { toolCall: { shell: { command: 'ls' } } },
      { assistantMessage: { text: 'B' } },
      { note: true },
    ] } } },
    { uuid: 'row-2', message: { turn: { case: 'agentConversationTurn', value: { userMessage: { text: 'Later', startedAtMs: 200 }, steps: [
      { message: { case: 'assistantMessage', value: { text: 'C' } } },
      { message: { case: 'thinkingMessage', value: { text: 'hmm' } } },
      { message: { case: 'toolCall', value: {} } },
      { message: { case: 'other', value: { text: 'nope' } } },
    ] } } } },
    { uuid: 'row-3', message: { agentConversationTurn: { userMessage: { startedAtMs: 'nope' }, steps: 'not-array' } } },
    { uuid: 'row-4', message: null },
    { uuid: 'row-5', message: { turn: { case: 'other', value: { userMessage: { text: 'hidden' } } }, agentConversationTurn: { userMessage: { text: 'Early', startedAtMs: 1 } } } },
  ], [
    { id: 'too-late', createdAt: 500 },
    { id: 'early', createdAt: 10 },
    { id: 'mid', createdAt: 100 },
    { id: 'missing' },
  ]);
  const row = (id: string) => messages.filter((message) => message.id.startsWith(id));
  assert.equal(row('row-1').find((message) => message.role === 'user')?.backendTurnId, 'early');
  assert.deepEqual(row('row-1').filter((message) => message.role === 'assistant').map((message) => [message.text, message.final === true]), [
    ['A', false], ['B', true],
  ]);
  assert.equal(row('row-1').find((message) => message.meta?.type === 'thinking')?.text, 'think');
  assert.equal(row('row-1').find((message) => message.role === 'tool')?.tool?.name, 'shell');
  assert.equal(row('row-2').find((message) => message.role === 'user')?.backendTurnId, 'mid');
  assert.equal(row('row-2').find((message) => message.role === 'assistant')?.final, true);
  assert.equal(row('row-2').find((message) => message.role === 'tool')?.tool?.name, 'tool');
  assert.equal(row('row-2').some((message) => message.text === 'nope'), false);
  assert.deepEqual(row('row-3'), []);
  assert.deepEqual(row('row-4'), []);
  const early = row('row-5').find((message) => message.role === 'user');
  assert.equal(early?.text, 'Early');
  assert.equal(early?.backendTurnId, undefined);
  assert.equal(early?.at, 1);
  assert.equal(messages.some((message) => message.text === 'hidden'), false);
});
