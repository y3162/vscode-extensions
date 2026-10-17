import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssistantSegments } from '../../../src/providers/segments.js';

test('assistant segments split on tool boundaries and ignore empty deltas', () => {
  const loose = new AssistantSegments();
  assert.equal(loose.push(''), undefined);
  assert.deepEqual(loose.push('Hello'), { id: 'assistant-1', text: 'Hello' });
  assert.deepEqual(loose.push('Hello world'), { id: 'assistant-1', text: 'Hello world' });
  loose.interrupt();
  assert.deepEqual(loose.push('\n\nnext'), { id: 'assistant-2', text: 'next' });
  assert.equal(loose.fullText(), 'Hello world\n\nnext');

  const strict = new AssistantSegments(true);
  assert.deepEqual(strict.push('ab'), { id: 'assistant-1', text: 'ab' });
  assert.deepEqual(strict.push('c'), { id: 'assistant-1', text: 'abc' });
  strict.interrupt();
  assert.equal(strict.push('\n'), undefined);
  assert.deepEqual(strict.push('zz', 'snapshot'), { id: 'assistant-2', text: 'zz' });
  assert.equal(strict.fullText(), 'zz');
});
