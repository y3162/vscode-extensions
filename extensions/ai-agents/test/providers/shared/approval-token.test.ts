import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../../src/chat-controller.js';
import type { Selection } from '../../../src/types.js';

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

test('parallel child approvals are queued, retain their tokens, and Stop releases every request', async () => {
  const controller = new ChatController(selection, async () => ({ async run() {}, async dispose() {} }), () => {});
  const request = { id: 'shared-tool-id', title: 'child command', detail: 'safe', kind: 'shell' as const };
  const first = controller.requestPermission(request);
  const firstToken = controller.interactionTokens().permission!;
  const second = controller.requestPermission({ ...request, title: 'second child' });
  controller.resolvePermission(request.id, 'allow-once', firstToken);
  assert.equal(await first, 'allow-once');
  assert.equal(controller.snapshot().pendingPermission?.title, 'second child');
  assert.notEqual(controller.interactionTokens().permission, firstToken);
  controller.resolvePermission(request.id, 'allow-once', firstToken);
  assert.equal(controller.snapshot().pendingPermission?.title, 'second child');
  const third = controller.requestPermission({ ...request, title: 'third child' });
  controller.stop();
  assert.deepEqual(await Promise.all([second, third]), ['deny', 'deny']);
  assert.equal(controller.snapshot().pendingPermission, null);
  await controller.dispose();
});
