import assert from 'node:assert/strict';

import { test } from 'node:test';

import { usageDifference, usageText } from '../../src/usage.js';

test('usage deltas omit one-sided fields and never invent a negative total', () => {
  const reasoning = usageDifference({ inputTokens: 2, outputTokens: 2, reasoningTokens: 4 }, { inputTokens: 1, outputTokens: 1 });
  assert.equal(reasoning?.inputTokens, 1);
  assert.equal(reasoning?.outputTokens, 1);
  assert.equal(Object.hasOwn(reasoning!, 'reasoningTokens'), false);
  const mixed = usageDifference({ inputTokens: 5, outputTokens: 4, cachedInputTokens: 1 }, { inputTokens: 2, outputTokens: 1, totalTokens: 9 });
  assert.equal(mixed?.inputTokens, 3);
  assert.equal(Object.hasOwn(mixed!, 'cachedInputTokens'), false);
  assert.equal(Object.hasOwn(mixed!, 'totalTokens'), false);
  const partial = usageDifference({ inputTokens: undefined as unknown as number, outputTokens: 2 }, { inputTokens: 1, outputTokens: 1 });
  assert.equal(partial?.outputTokens, 1);
  assert.equal(partial?.inputTokens, undefined);
  assert.equal(usageDifference({ inputTokens: 1, outputTokens: 1, totalTokens: 1 }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }), undefined);
  assert.equal(usageText(undefined), '未取得 / Not reported');
  assert.match(usageText({ inputTokens: 1000, outputTokens: 0 }), /Input 1,000/);
  assert.match(usageText({ inputTokens: 1, outputTokens: 2, totalTokens: undefined }, 'missing'), /Total —/);
});;
