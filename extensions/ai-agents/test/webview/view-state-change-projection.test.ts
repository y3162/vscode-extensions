import assert from 'node:assert/strict';

import { test } from 'node:test';

import { presentChange, toViewMessage, diffMessages } from '../../src/view-state.js';

test('view projection marks outside absolute changes synthetic and removes stale message ids', () => {
  const outside = presentChange({ path: '/outside/secret.txt', kind: 'update', diff: '+secret\n' }, ['/workspace']);
  assert.equal(outside.synthetic, true);
  assert.equal(outside.name, 'Patch');
  assert.equal(outside.canRevert, false);
  assert.equal(outside.patch, '+secret\n');

  const user = toViewMessage({ id: 'user', role: 'user', text: 'prompt' });
  assert.equal(user.canRewind, false);
  const diff = diffMessages(new Map([['old', '{"id":"old"}']]), []);
  assert.deepEqual(diff.removed, ['old']);
  assert.deepEqual(diff.upserts, []);
  assert.deepEqual(diff.order, []);
});
