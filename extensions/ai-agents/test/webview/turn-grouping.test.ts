import assert from 'node:assert/strict';

import { test } from 'node:test';

import { buildTurns } from '../../src/webview/turns.js';

import type { ModelCatalogMessage, ViewMessage, ViewShell, VsCodeApi } from '../../src/protocol.js';

test('turn grouping keeps empty tool names, absent timestamps, and backend timing overrides', () => {
  const messages: ViewMessage[] = [
    { id: 'user-1', role: 'user', text: 'prompt' },
    { id: 'plain-tool', role: 'tool', text: 'raw detail' },
    { id: 'empty-tool', role: 'tool', text: 'Custom:   ' },
    { id: 'answer', role: 'assistant', text: 'done', final: true },
  ];
  const [turn] = buildTurns(messages, false, false, [{
    id: 'user-1', startedAt: 10, endedAt: 20, waitMs: 3, status: 'completed', intent: 'chat',
  }]);
  assert.equal(turn?.user?.at, undefined);
  assert.equal(turn?.startedAt, 10);
  assert.equal(turn?.endedAt, 20);
  assert.deepEqual(turn?.log.filter((segment) => segment.type === 'tools').flatMap((segment) => segment.tools.map((tool) => tool.name)), [
    'raw detail', 'Custom:   ',
  ]);
  assert.equal(turn?.answer?.text, 'done');
});
