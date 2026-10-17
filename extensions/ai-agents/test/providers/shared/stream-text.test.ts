import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeStreamText } from '../../../src/providers/stream-text.js';

test('stream text keeps a snapshot and appends a delta', () => {
  assert.equal(mergeStreamText('', 'Hello'), 'Hello');
  assert.equal(mergeStreamText('Hello', 'Hello world'), 'Hello world');
  assert.equal(mergeStreamText('Hello world', 'Hello'), 'Hello world');
  assert.equal(mergeStreamText('Hello', ' world'), 'Hello world');
  assert.equal(mergeStreamText('Hello world', 'world'), 'Hello world');
  assert.equal(mergeStreamText('Hello', ''), 'Hello');
});
