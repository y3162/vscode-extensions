import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';
import type { AgentSession, Selection } from '../../src/types.js';

const selection: Selection = { provider: 'codex', cwd: '/workspace', model: '' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('review replaces repeated item snapshots and absorbs usage while suppressing output after cancellation', async () => {
  const entered = deferred<{
    emit: Parameters<NonNullable<AgentSession['review']>>[1];
    signal: AbortSignal;
  }>();
  const abortObserved = deferred<void>();
  let controller!: ChatController;
  const session: AgentSession = {
    async run() {},
    async review(_target, emit, signal) {
      entered.resolve({ emit, signal });
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          queueMicrotask(() => {
            emit({ id: 'late-answer', role: 'assistant', text: 'must not appear' });
            emit({
              id: 'late-usage', role: 'status', text: '',
              meta: { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, scope: 'request', source: 'review' } },
            });
            abortObserved.resolve();
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }, { once: true });
      });
    },
    async dispose() {},
  };
  controller = new ChatController(selection, async () => session, () => {});

  await controller.openSession();
  const reviewing = controller.review('uncommitted');
  const { emit, signal } = await entered.promise;
  assert.equal(signal.aborted, false);
  emit({ id: 'same-item', role: 'assistant', text: 'first snapshot' });
  const first = controller.snapshot().messages.find((message) => message.text === 'first snapshot');
  assert.ok(first);
  emit({ id: 'same-item', role: 'assistant', text: 'complete snapshot', final: true });
  const state = controller.snapshot();
  const matching = state.messages.filter((message) => message.id === first.id);
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.text, 'complete snapshot');
  assert.equal(matching[0]?.at, first.at);
  assert.equal(matching[0]?.final, true);

  controller.stop();
  await abortObserved.promise;
  await reviewing;
  const after = controller.snapshot();
  assert.equal(after.busy, false);
  assert.equal(after.status, 'idle');
  assert.equal(after.messages.some((message) => message.text === 'must not appear'), false);
  assert.equal(after.messages.some((message) => message.text === '停止しました。' && message.role === 'status'), true);
  assert.equal(after.usage?.inputTokens, 12);
  assert.equal(after.usage?.outputTokens, 3);
});

test('ordinary review failures release the controller and retain a retryable error without repair instructions', async () => {
  const controller = new ChatController(selection, async () => ({
    async run() {},
    async review() { throw new Error('temporary backend outage'); },
    async dispose() {},
  }), () => {});

  await controller.openSession();
  await controller.review('base');
  const state = controller.snapshot();
  const error = state.messages.find((message) => message.role === 'error');
  assert.equal(error?.text, 'temporary backend outage');
  assert.equal(error?.text.includes('設定の修正が必要'), false);
  assert.equal(state.busy, false);
  assert.equal(state.status, 'idle');
  assert.equal(controller.hasSession(), true);
});

test('rewind preview describes the selected prompt and size-limited change summaries stay untrusted', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-controller-preview-'));
  const filePath = path.join(cwd, 'large.txt');
  const initial = 'x\n'.repeat(4001);
  await writeFile(filePath, initial, { mode: 0o644 });
  let sessionId = 'thread-1';
  let backendTurnId = '';
  let requestHibernate = false;
  let hibernateDuringRewind: Promise<void> | undefined;
  let controller!: ChatController;
  const persistence: RewindPersistence = {
    journalDirectory: path.join(cwd, '.journals'),
    conversationId: () => 'conversation-1',
    enabled: () => true,
    async flush() {},
  };
  controller = new ChatController({ ...selection, cwd }, async () => ({
    get sessionId() { return sessionId; },
    activateFork(id: string) { sessionId = id; },
    latestBackendTurnId: () => backendTurnId,
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id: string) { return `branch-${id}`; },
    async run(prompt, _signal, emit) {
      if (prompt === 'first prompt') {
        backendTurnId = 'backend-1';
        await writeFile(filePath, 'middle\n', { mode: 0o644 });
        emit({ id: 'workspace-changes:backend-1', role: 'tool', text: 'first diff', backendTurnId,
          meta: { type: 'files', files: [{ path: 'large.txt', kind: 'update', previousText: initial, previousMode: 0o644, additions: 1, deletions: 1 }] } });
      } else if (prompt === 'second prompt') {
        backendTurnId = 'backend-2';
        await writeFile(filePath, 'after\n', { mode: 0o644 });
        emit({ id: 'workspace-changes:backend-2', role: 'tool', text: 'second diff', backendTurnId,
          meta: { type: 'files', files: [{ path: 'large.txt', kind: 'update', previousText: 'middle\n', previousMode: 0o644, additions: 1, deletions: 1 }] } });
      } else {
        backendTurnId = 'backend-edited';
      }
    },
    async dispose() {},
  }), (state) => {
    if (requestHibernate && state.operationLabel === 'rewind-check') {
      requestHibernate = false;
      hibernateDuringRewind = controller.hibernate();
    }
  }, persistence);

  try {
    await controller.send('first prompt');
    await controller.send('second prompt');
    const target = controller.snapshot().turns[1]!;
    assert.equal(controller.rewindableTurnIds().has(target.id), true);
    assert.deepEqual(await controller.previewRewind(target.id), {
      targetId: target.id, prompt: 'second prompt', removedTurns: 1, files: ['large.txt'],
    });

    requestHibernate = true;
    await controller.rewindAndSend(target.id, 'edited prompt');
    await hibernateDuringRewind;
    assert.equal(controller.hasSession(), true, 'Hibernate must not dispose the session mid-rewind');
    assert.equal(await readFile(filePath, 'utf8'), 'middle\n');
    const aggregate = controller.snapshot().changes.find((change) => change.path.endsWith('/large.txt'));
    assert.ok(aggregate);
    assert.equal(aggregate.kind, 'update');
    assert.equal(Object.hasOwn(aggregate, 'additions'), false);
    assert.equal(Object.hasOwn(aggregate, 'deletions'), false);
  } finally {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
