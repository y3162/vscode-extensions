import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptManagedRun } from '../../../src/providers/managed-run-admission.js';

test('managed run admission keeps reconnects idempotent and enforces the owner limit', () => {
  const accepted = new Set<string>();
  assert.equal(acceptManagedRun('first', undefined, accepted, 2), true);
  assert.equal(acceptManagedRun('first', { id: 'first', status: 'completed', updates: [] }, accepted, 2), false);
  assert.throws(() => acceptManagedRun('second', { id: 'first', status: 'running', updates: [] }, accepted, 2), /still running/);
  assert.equal(acceptManagedRun('second', { id: 'first', status: 'completed', updates: [] }, accepted, 2), true);
  assert.throws(() => acceptManagedRun('first', { id: 'second', status: 'completed', updates: [] }, accepted, 2), /already accepted/);
  assert.throws(() => acceptManagedRun('third', { id: 'second', status: 'completed', updates: [] }, accepted, 2), /run limit/);
  assert.deepEqual([...accepted], ['first', 'second']);
});
