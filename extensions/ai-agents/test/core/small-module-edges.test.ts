import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { lineChangeCounts, previewTextDiff, previousTextFromDiff } from '../../src/diff-stats.js';
import { SessionRegistry } from '../../src/session-registry.js';
import type { Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: 'fixture' };

function makeController(sessionId: string): ChatController {
  return new ChatController(selection, async () => ({
    sessionId,
    async run() {},
    async dispose() {},
  }), () => {});
}

test('registry reports restored child and terminal activity while idle and counts idle sessions as stopped', async () => {
  const controller = makeController('restored-session');
  const registry = new SessionRegistry(controller, 'agent');
  controller.prepareResume('restored-session');
  await controller.openSession();

  assert.equal(controller.snapshot().busy, false);
  assert.equal(registry.runningCount(), 0);
  assert.equal(registry.activityFor('restored-session'), 'idle');

  // These statuses can outlive the busy turn flag during async cleanup.
  controller.setStatus('running');
  assert.equal(registry.runningCount(), 0);
  assert.equal(registry.activityFor('restored-session'), 'running');
  controller.setStatus('cancelling');
  assert.equal(registry.activityFor('restored-session'), 'running');

  controller.setStatus('idle');
  controller.setTerminals([{ processId: 'terminal-without-status' }]);
  assert.equal(registry.activityFor('restored-session'), 'running');
  controller.setTerminals([{ processId: 'finished-terminal', status: 'completed' }]);
  assert.equal(registry.activityFor('restored-session'), 'idle');

  const saved = controller.snapshot();
  saved.subagents = [{ id: 'child', name: 'Child', status: 'running', background: true }];
  controller.restoreSnapshot(saved, 'restored-session');
  assert.equal(controller.snapshot().subagents[0]?.status, 'unknown');
  assert.equal(registry.activityFor('restored-session'), 'running');

  saved.subagents[0]!.status = 'completed';
  controller.restoreSnapshot(saved, 'restored-session');
  assert.equal(registry.activityFor('restored-session'), 'idle');
  await controller.dispose();
});

test('diff helpers preserve empty-file newline changes and reject partial deletion baselines', () => {
  assert.deepEqual(previewTextDiff('', '\n'), [
    { kind: 'add', line: 1, text: '' },
  ]);
  assert.deepEqual(lineChangeCounts('\n', ''), { additions: 0, deletions: 1 });
  assert.equal(
    previousTextFromDiff('@@ -1,2 +0,0 @@\n-secret\n context\n', 'delete'),
    undefined,
    'a deletion hunk with context is incomplete and cannot be used as a restore baseline',
  );
});
