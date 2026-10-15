import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../src/chat-controller.js';
import type { Selection } from '../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };

test('an approval answer is ignored when its token belongs to another wait', async () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const first = controller.requestPermission({ id: 'perm', title: 'npm test', detail: 'npm test', kind: 'shell' });
  const stale = controller.interactionTokens().permission;
  assert.ok(stale);
  controller.stop();
  assert.equal(await first, 'deny');
  const second = controller.requestPermission({ id: 'perm', title: 'npm test', detail: 'npm test', kind: 'shell' });
  controller.resolvePermission('perm', 'allow-once', stale);
  assert.equal(controller.snapshot().pendingPermission?.title, 'npm test');
  controller.resolvePermission('perm', 'allow-once', controller.interactionTokens().permission ?? undefined);
  assert.equal(await second, 'allow-once');
  assert.equal(controller.snapshot().pendingPermission, null);
});
