import assert from 'node:assert/strict';

import { test } from 'node:test';

import { mergeRegistrySessions, sessionTitle, upsertSession } from '../../src/session-index.js';

import { ChatController } from '../../src/chat-controller.js';

import { SessionRegistry } from '../../src/session-registry.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

const mode = 0o644;

function selection(cwd = '/work'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

test('session titles and registry rows keep activity, fallbacks, and the focused conversation', async () => {
  assert.equal(sessionTitle(''), 'New chat');
  assert.equal(sessionTitle('x'.repeat(79)).length, 79);
  assert.equal(sessionTitle('x'.repeat(80)).length, 80);
  assert.equal(sessionTitle('x'.repeat(81)).length, 80);
  const current = [{ id: 'a', title: 'Saved', updatedAt: 't0', provider: 'codex' as const, cwd: '/work', activity: 'idle' as const, backend: 'sdk' as const }];
  const merged = mergeRegistrySessions(current, [
    { id: 'a', title: 'a', updatedAt: 't1', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'b', title: '', updatedAt: 't1', provider: 'codex', cwd: '/work' },
    { id: 'c', title: 'Real', updatedAt: 't1', provider: 'codex', cwd: '/work', activity: 'running' },
    { id: 'a', title: 'Renamed', updatedAt: 't2', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'a', title: '', updatedAt: 't3', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'a', title: 'Other backend', updatedAt: 't1', provider: 'codex', cwd: '/work', backend: 'app-server' },
  ]);
  assert.equal(merged.find((item) => item.id === 'a' && item.backend === 'sdk')?.title, 'Renamed');
  assert.equal(merged.find((item) => item.id === 'a' && item.backend === 'sdk')?.activity, 'idle');
  assert.equal(merged.find((item) => item.id === 'b')?.title, 'b');
  assert.equal(merged.find((item) => item.id === 'c')?.activity, 'running');
  assert.equal(merged.filter((item) => item.id === 'a').length, 2);
  assert.equal(upsertSession([], { id: 'a', title: 'A', updatedAt: '', provider: 'cursor' })[0]?.title, 'A');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const front = new ChatController(selection(), async () => ({
    sessionId: 'front-session',
    async run() { entered(); await gate; },
    async dispose() {},
  }), () => {});
  const registry = new SessionRegistry(front, 'agent');
  const running = front.send('investigate registry titles that are longer than eighty characters and should be sliced at the boundary');
  await started;
  const waiting = new ChatController(selection(), async () => ({ sessionId: 'wait-session', async run() {}, async dispose() {} }), () => {});
  waiting.prepareResume('wait-session');
  await waiting.openSession();
  const pending = waiting.interactions.requestPermission({ id: 'p', title: 'Read', detail: 'file', kind: 'read' });
  await Promise.resolve();
  registry.add({ key: 'waiting', controller: waiting, mode: 'plan' });
  const errored = new ChatController(selection(), async () => ({ sessionId: 'err-session', async run() { throw new Error('boom'); }, async dispose() {} }), () => {});
  await errored.send('fail');
  registry.add({ key: 'errored', controller: errored, mode: 'ask' });
  const untitled = new ChatController(selection(), async () => ({ sessionId: 'only-id', async run() {}, async loadTranscript() {}, async dispose() {} }), () => {});
  untitled.prepareResume('only-id');
  await untitled.openSession();
  registry.add({ key: 'untitled', controller: untitled, mode: 'agent' });
  registry.focus('missing');
  assert.equal(registry.frontKey, 'front');
  assert.equal(registry.front, front);
  registry.focus('waiting');
  assert.equal(registry.frontKey, 'waiting');
  assert.equal(registry.mode(), 'plan');
  registry.setMode('ask');
  assert.equal(registry.mode(), 'ask');
  assert.equal(registry.findBySession('err-session')?.key, 'errored');
  assert.equal(registry.findBySession('absent'), undefined);
  assert.equal(registry.activityFor('wait-session'), 'waiting');
  assert.equal(registry.activityFor('err-session'), 'error');
  assert.equal(registry.activityFor('front-session'), 'running');
  assert.equal(registry.activityFor('nobody'), undefined);
  const rows = registry.liveSummaries();
  assert.equal(rows.find((item) => item.id === 'only-id')?.title, 'only-id');
  assert.equal(rows.find((item) => item.id === 'wait-session')?.title, 'wait-session');
  assert.equal(rows.find((item) => item.id === 'front-session')?.title.length, 80);
  const background = [...registry.background()].map((entry) => entry.key);
  assert.equal(background.includes('waiting'), false);
  assert.deepEqual(background.sort(), ['errored', 'front', 'untitled']);
  (registry as unknown as { items: Map<string, unknown> }).items.delete('waiting');
  assert.throws(() => registry.front, /会話が見つかりません/);
  assert.throws(() => registry.mode(), /会話が見つかりません/);
  assert.throws(() => registry.setMode('agent'), /会話が見つかりません/);
  waiting.resolvePermission('p', 'deny');
  await pending;
  release();
  await running;
  await front.dispose();
  await waiting.dispose();
  await errored.dispose();
  await untitled.dispose();
});;

test('provider titles survive local history and live session updates', () => {
  const local = { id: 'thread', title: 'Original prompt', titleSource: 'local' as const, updatedAt: 't0', provider: 'codex' as const };
  const official = { ...local, title: 'Official title', titleSource: 'provider' as const, updatedAt: 't1' };
  let sessions = upsertSession([local], official);
  sessions = mergeRegistrySessions(sessions, [{ ...local, title: 'Original prompt again', updatedAt: 't2', activity: 'running' }]);
  assert.equal(sessions[0]?.title, 'Official title');
  assert.equal(sessions[0]?.titleSource, 'provider');
  assert.equal(sessions[0]?.activity, 'running');
  sessions = upsertSession(sessions, { ...local, title: 'thread', updatedAt: 't3' });
  assert.equal(sessions[0]?.title, 'Official title');
  sessions = upsertSession(sessions, { ...official, title: 'Renamed by provider', updatedAt: 't4' });
  assert.equal(sessions[0]?.title, 'Renamed by provider');
  const legacy = { id: 'old', title: 'Previously saved title', updatedAt: 't0', provider: 'cursor' as const };
  assert.equal(upsertSession([legacy], { id: 'old', provider: 'cursor', title: 'First prompt', updatedAt: 't1' })[0]?.title, 'First prompt');
  assert.equal(upsertSession([legacy], { ...local, id: 'old', provider: 'cursor', title: 'First prompt', titleSource: 'local' })[0]?.title, 'Previously saved title');
  const cursor = { ...local, id: 'cursor-agent', provider: 'cursor' as const, title: 'First request' };
  const refreshed = upsertSession([cursor], { ...cursor, title: 'New Agent', titleSource: 'provider' });
  assert.equal(refreshed[0]?.title, 'First request');
  assert.equal(refreshed[0]?.titleSource, 'local');
  const recovered = upsertSession([{ ...cursor, title: 'New Agent' }], { ...cursor, title: 'First request', titleSource: 'local' });
  assert.equal(recovered[0]?.title, 'First request');
  assert.equal(recovered[0]?.titleSource, 'local');
});
