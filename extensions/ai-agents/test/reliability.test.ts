import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../src/history-store.js';
import { ChatController } from '../src/chat-controller.js';
import { defaultControls } from '../src/capabilities.js';
import { usageDifference } from '../src/usage.js';
import type { AgentUpdate } from '../src/types.js';
const selection = { provider: 'codex' as const, cwd: '/verification', model: 'fixture' };

test('display history survives a new controller without resubmitting old prompts or duplicating usage', async () => {
  const calls: string[] = [];
  const factory = async () => ({ sessionId: 'thread', async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
    calls.push(prompt); const count = calls.length;
    emit({ id: 'answer', role: 'assistant', text: `${prompt} 日本語\n${'long'.repeat(10000)}` });
    emit({ id: 'usage', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: count * 10, outputTokens: count, totalTokens: count * 11, scope: 'session', source: 'codex-sdk' } } });
  }, async dispose() {} });
  const controller = new ChatController(selection, factory, () => {});
  for (const prompt of ['one', 'two', 'three']) await controller.send(prompt);
  assert.equal(controller.snapshot().usage?.totalTokens, 33);
  assert.deepEqual(controller.snapshot().turns.map((t) => t.usage?.totalTokens), [11, 11, 11]);
  assert.ok(controller.snapshot().messages.at(-1)!.text.length > 32000);
  const root = await mkdtemp(path.join(tmpdir(), 'ai-history-test-'));
  const store = new HistoryStore(root);
  store.schedule({ version: 1, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sessionId: 'thread', updatedAt: new Date().toISOString(), controls: defaultControls('codex', 'sdk'), state: controller.snapshot() });
  await store.flush();
  const reloaded = new HistoryStore(root); await reloaded.load();
  const saved = reloaded.get('thread')!; assert.ok(saved);
  const restored = new ChatController(selection, factory, () => {});
  restored.restoreSnapshot(saved.state, saved.sessionId);
  await restored.openSession();
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.equal(restored.snapshot().messages.filter((m) => m.role === 'user').length, 3);
  await restored.send('four');
  assert.equal(restored.snapshot().usage?.totalTokens, 44);
  assert.equal(restored.snapshot().turns.at(-1)?.usage?.totalTokens, 11);
  await writeFile(path.join(root, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json'), '{broken');
  const corrupt = new HistoryStore(root); await corrupt.load();
  assert.equal(corrupt.errors.length, 1); assert.ok(corrupt.get('thread'));
  assert.equal(await readFile(path.join(root, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json'), 'utf8'), '{broken');
});

test('configuration failure stops queued automatic resubmission and Retry preserves one user bubble', async () => {
  let fail = true; let calls = 0;
  const controller = new ChatController(selection, async () => ({ async run() { calls++; if (fail) throw Object.assign(new Error('sandbox unsupported'), { name: 'ConfigurationError', isRetryable: false }); }, async dispose() {} }), () => {});
  await controller.send('Hi');
  const id = controller.snapshot().messages[0]!.id;
  fail = false;
  await controller.send('Hi', { retryOf: id });
  const state = controller.snapshot();
  assert.equal(calls, 2); assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(state.messages.filter((m) => m.role === 'error').length, 1);
  assert.equal(state.turns.at(-1)?.userMessageId, id);
  assert.equal(state.messages.find((m) => m.role === 'error')?.failure?.retryable, false);
});

test('usage repeated snapshots replace values and preserve unavailable cache/reasoning', () => {
  assert.deepEqual(usageDifference({ inputTokens: 32003, outputTokens: 11, cachedInputTokens: 28416 }, { inputTokens: 15991, outputTokens: 5, cachedInputTokens: 12544 }), { inputTokens: 16012, outputTokens: 6, cachedInputTokens: 15872, scope: 'turn' });
  assert.equal(usageDifference({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 10, outputTokens: 10 }), undefined);
});

test('Cursor public stored turn restores its user, thoughts, tools and answer', async () => {
  const { cursorStoredMessages } = await import('../src/providers/cursor-history.js');
  const messages = cursorStoredMessages([{ uuid: 'agent:0', message: { agentConversationTurn: { userMessage: { text: 'Hi', startedAtMs: '120' }, steps: [{ thinkingMessage: { text: 'Public summary' } }, { toolCall: { shell: { args: { command: 'printf hi' }, result: { stdout: 'hi' } } } }, { assistantMessage: { text: '**Hi**' } }] } } }], [{ id: 'run-1', createdAt: 100 }]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'status', 'tool', 'assistant']);
  assert.ok(messages.every((m) => m.backendTurnId === 'run-1'));
  assert.equal(messages.at(-1)?.final, true); assert.match(messages[2]!.text, /stdout/);
});

test('Cursor protobuf oneof objects are normalized before JSON serialization', async () => {
  const { cursorStoredMessages } = await import('../src/providers/cursor-history.js');
  const messages = cursorStoredMessages([{ uuid: 'agent:0', message: { turn: { case: 'agentConversationTurn', value: { userMessage: { text: 'Hi', startedAtMs: 120n }, steps: [{ message: { case: 'assistantMessage', value: { text: 'Hello' } } }] } } } }], [{ id: 'run-1', createdAt: 100 }]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']); assert.equal(messages[0]?.backendTurnId, 'run-1');
});

test('a backend error event followed by the same rejected run produces one error card', async () => {
  const controller = new ChatController(selection, async () => ({ async run(_prompt, _signal, emit) { emit({ id: 'failure', role: 'error', text: 'connection failed' }); throw new Error('connection failed'); }, async dispose() {} }), () => {});
  await controller.send('Hi');
  assert.equal(controller.snapshot().messages.filter((m) => m.role === 'error').length, 1);
});

test('backend replay reconciles native IDs without duplicating recorded users or answers', async () => {
  const factory = async () => ({ sessionId: 'thread', async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) { emit({ id: 'answer', backendTurnId: 'native-1', role: 'assistant', text: 'Saved' }); }, async loadTranscript(emit: (message: import('../src/types.js').ChatMessage) => void) {
    emit({ id: 'native-user', backendTurnId: 'native-1', role: 'user', text: 'Hi' });
    emit({ id: 'native-answer', backendId: 'answer', backendTurnId: 'native-1', role: 'assistant', text: 'Saved answer' });
    emit({ id: 'external-user', backendTurnId: 'native-2', role: 'user', text: 'Another client' });
    emit({ id: 'external-answer', backendTurnId: 'native-2', role: 'assistant', text: 'External answer' });
  }, async dispose() {} });
  const original = new ChatController(selection, factory, () => {}); await original.send('Hi');
  const restored = new ChatController(selection, factory, () => {}); restored.restoreSnapshot(original.snapshot(), 'thread'); await restored.openSession();
  assert.deepEqual(restored.snapshot().messages.map((m) => m.text), ['Hi', 'Saved answer', 'Another client', 'External answer']);
  await restored.openSession(); assert.equal(restored.snapshot().messages.length, 4);
});

test('a long conversation retains complete turns past the old 300-message and 40-turn limits', async () => {
  const controller = new ChatController(selection, async () => ({ async run(_prompt, _signal, emit) { emit({ id: 'answer', role: 'assistant', text: 'ok' }); }, async dispose() {} }), () => {});
  for (let i = 0; i < 160; i++) await controller.send(`message ${i}`);
  const state = controller.snapshot(); assert.equal(state.messages.length, 320); assert.equal(state.turns.length, 160);
  const restored = new ChatController(selection, async () => { throw Error('must not connect'); }, () => {});
  restored.restoreSnapshot(state, 'thread'); assert.deepEqual(restored.snapshot().messages, state.messages);
});

test('request-only usage accumulates across turns and replaces repeated samples', async () => {
  let cumulative = false;
  const controller = new ChatController(selection, async () => ({
    async run(_prompt, _signal, emit) {
      if (cumulative) emit({ id: 'total', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: 40, outputTokens: 4, scope: 'session', source: 'codex-app-server' } } });
      for (const outputTokens of [1, 2]) emit({ id: 'request', role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: 10, outputTokens, scope: 'request', source: 'codex-app-server' } } });
    }, async dispose() {},
  }), () => {});
  await controller.send('one');
  await controller.send('two');
  assert.equal(controller.snapshot().usage?.inputTokens, 20);
  assert.equal(controller.snapshot().usage?.outputTokens, 4);
  assert.deepEqual(controller.snapshot().turns.map((turn) => turn.usage?.outputTokens), [2, 2]);
  cumulative = true;
  await controller.send('native cumulative');
  assert.equal(controller.snapshot().usage?.inputTokens, 40);
  assert.equal(controller.snapshot().usage?.outputTokens, 4);
  assert.equal(controller.snapshot().turns.at(-1)?.usage, undefined, 'the first cumulative sample in a later turn has no known starting baseline');
});

test('restoring completed terminal records does not turn a finished chat into live background work', () => {
  const controller = new ChatController(selection, async () => { throw new Error('no connection expected'); }, () => {});
  const saved = controller.snapshot();
  saved.terminals = [{ processId: 'done', status: 'completed', exitCode: 0, output: 'done' }, { processId: 'stopped', status: 'cancelled', exitCode: 130 }];
  controller.restoreSnapshot(saved, 'thread');
  assert.equal(controller.hasLiveTerminals(), false);
  assert.deepEqual(controller.snapshot().terminals, saved.terminals);
  saved.terminals.push({ processId: 'running', status: 'running' });
  controller.restoreSnapshot(saved, 'thread');
  assert.equal(controller.snapshot().terminals.at(-1)?.status, 'unknown');
  assert.equal(controller.hasLiveTerminals(), true);
});
