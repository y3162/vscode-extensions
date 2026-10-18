import assert from 'node:assert/strict';

import { writeFileSync } from 'node:fs';

import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';

import type { AgentSession, AgentUpdate, ChatState, ImageAttachment, Selection } from '../../src/types.js';

const fileMode = 0o644;

const image: ImageAttachment = { mimeType: 'image/png', data: 'YQ==', name: 'a.png' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selection(cwd = '/workspace'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function persistence(journals: string, enabled = true, conversationId: () => string | undefined = () => 'conversation-1'): RewindPersistence & { flushes: number } {
  const store = { journalDirectory: journals, flushes: 0, conversationId, enabled: () => enabled, flush: async () => { store.flushes += 1; } };
  return store;
}

async function workspace() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-controller-gap-')));
  const journals = path.join(path.dirname(cwd), `journals-${path.basename(cwd)}`);
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-controller-out-')));
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  return {
    cwd, journals, outside, secret,
    async cleanup() {
      await chmod(cwd, 0o700).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
      await rm(journals, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

function planOf(controller: ChatController): ChatState['plan'] {
  return (controller as unknown as { state: ChatState }).state.plan;
}

test('disabled history, blank edits, and the 100000 character boundary never open a second run', async () => {
  const runs: string[] = [];
  let opens = 0;
  let forks = 0;
  const ran = deferred();
  const controller = new ChatController(selection(), async () => {
    opens += 1;
    return { async run(prompt: string) { runs.push(prompt); ran.resolve(); }, async dispose() {}, async forkBeforeTurn() { forks += 1; return 'branch'; } };
  }, () => {}, persistence('/tmp/unused-journals', false));
  await assert.rejects(controller.previewRewind('missing'), /無効/);
  await assert.rejects(controller.rewindAndSend('missing', 'edited'), /無効/);
  await controller.rewindAndSend('missing', '   ');
  await controller.rewindAndSend('missing', '', { images: [] });
  await controller.enqueue('   ');
  void controller.enqueue('a'.repeat(100_000));
  await ran.promise;
  assert.throws(() => controller.enqueue('a'.repeat(100_001)), /100,000/);
  await assert.rejects(controller.rewindAndSend('missing', 'b'.repeat(100_001)), /100,000/);
  await assert.rejects(controller.rewindAndSend('missing', '  ', { images: [image] }), /無効/);
  assert.deepEqual(runs.map((item) => item.length), [100_000]);
  assert.equal(opens, 1);
  assert.equal(forks, 0);
  assert.equal(controller.snapshot().queue.length, 0);
});

test('rewind is refused while busy, resetting, changing models, or holding a queue', async () => {
  const dir = await workspace();
  const runs: string[] = [];
  let opens = 0;
  const entered = deferred();
  const release = deferred();
  const disposeGate = deferred();
  const modelGate = deferred();
  let session: AgentSession;
  const controller = new ChatController(selection(dir.cwd), async () => {
    opens += 1;
    session = {
      sessionId: 'thread-1',
      async run(prompt, signal) {
        runs.push(prompt);
        if (prompt !== 'hold') return;
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          release.resolve = resolve;
        });
      },
      async setModel() { await modelGate.promise; },
      async dispose() { await disposeGate.promise; },
      async forkBeforeTurn() { throw new Error('fork must not run'); },
    };
    return session;
  }, () => {}, persistence(dir.journals));
  try {
    const holding = controller.send('hold');
    await entered.promise;
    await assert.rejects(controller.previewRewind('x'), /巻き戻せません/);
    controller.enqueue('later');
    controller.stop();
    release.resolve();
    await holding;
    assert.deepEqual(runs, ['hold']);
    await assert.rejects(controller.previewRewind('x'), /Queue/);
    assert.deepEqual(runs, ['hold']);
    const queued = controller.snapshot().queue[0]!;
    controller.removeQueued(queued.id);
    assert.equal(controller.snapshot().queue.length, 0);
    assert.deepEqual(runs, ['hold']);
    const resetting = controller.reset();
    await assert.rejects(controller.previewRewind('x'), /巻き戻せません/);
    disposeGate.resolve();
    await resetting;
    await controller.send('ready');
    const updating = controller.updateSelection({ ...selection(dir.cwd), model: 'next' });
    await assert.rejects(controller.previewRewind('x'), /巻き戻せません/);
    modelGate.resolve();
    await updating;
    assert.equal(opens, 2);
    assert.equal(await readFile(dir.secret, 'utf8'), 'secret');
    assert.equal((await stat(dir.secret)).mode & 0o777, 0o640);
  } finally { await dir.cleanup(); }
});

test('pending permission, plan, and question requests block rewind without another session', async () => {
  let opens = 0;
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => {
    opens += 1;
    return { sessionId: 'thread-1', async run() {}, async dispose() {}, async forkBeforeTurn() { throw new Error('fork must not run'); } };
  }, () => {}, persistence('/tmp/unused-journals'));
  await controller.send('first');
  const permission = controller.interactions.requestPermission({ id: 'perm', title: 'Read', detail: 'file', kind: 'read' });
  await Promise.resolve();
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().pendingPermission?.id, 'perm');
  await controller.hibernate();
  assert.equal(controller.hasSession(), true);
  await assert.rejects(controller.previewRewind('x'), /保留/);
  controller.resolvePermission('perm', 'deny', 'wrong');
  assert.equal(controller.snapshot().pendingPermission?.id, 'perm');
  controller.resolvePermission('perm', 'deny', controller.interactionTokens().permission!);
  assert.equal(await permission, 'deny');
  await controller.hibernate();
  assert.equal(controller.hasSession(), false);
  await controller.send('second');
  const plan = controller.interactions.requestPlan({ id: 'plan', plan: 'text', todos: [] });
  await Promise.resolve();
  await assert.rejects(controller.previewRewind('x'), /保留/);
  controller.resolvePlan('plan', 'rejected', controller.interactionTokens().plan!);
  assert.equal(await plan, 'rejected');
  const answers = controller.interactions.requestAnswers({ id: 'q', questions: [] });
  await Promise.resolve();
  await assert.rejects(controller.previewRewind('x'), /保留/);
  controller.resolveAnswers('q', { a: ['yes'] }, controller.interactionTokens().question!);
  assert.deepEqual(await answers, { a: ['yes'] });
  assert.equal(opens, 2);
  assert.equal(controller.snapshot().turns.length, 2);
});

test('planning and revising phases reject rewind before any fork, and build does too', async () => {
  const runs: string[] = [];
  let forks = 0;
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => ({
    sessionId: 'thread-1',
    async run(prompt, _signal, emit) {
      runs.push(prompt);
      if (runs.length === 1) emit({ id: 'plan', role: 'status', text: 'plan', meta: { type: 'plan', plan: { markdown: 'Ship it', source: 'assistant-text', todos: [{ content: 'step', status: 'pending' }] } } });
    },
    async setModel() {},
    async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
  }), () => {}, persistence('/tmp/unused-journals'));
  for (const phase of ['planning', 'revising', 'building'] as const) {
    planOf(controller).phase = phase;
    await assert.rejects(controller.rewindAndSend('missing', 'edited'), /Plan \/ Build/);
    assert.equal(controller.snapshot().plan.phase, phase);
    assert.equal(forks, 0);
    assert.equal(controller.snapshot().busy, false);
  }
  planOf(controller).phase = 'idle';
  controller.setModePreference('plan');
  await controller.send('draft the plan');
  const current = controller.snapshot().plan.current!;
  assert.equal(controller.snapshot().plan.phase, 'ready');
  await controller.build(current.id, current.revision, selection());
  assert.equal(runs.filter((item) => item === 'edited').length, 0);
  assert.equal(runs.length, 2);
  assert.equal(forks, 0);
  assert.equal(controller.snapshot().plan.phase, 'implemented');
});

test('live children, orphan children, and live terminals block rewind', async () => {
  let forks = 0;
  let controller!: ChatController;
  controller = new ChatController(selection(), async () => ({
    sessionId: 'thread-1',
    async run(_prompt, _signal, emit) {
      emit({ id: 'child', role: 'status', text: 'running', meta: { type: 'subagent', subagent: { id: 'child', name: 'Child', status: 'running', background: true } } });
    },
    async review(_target, emit) {
      emit({ id: 'orphan', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { id: 'orphan', name: 'Orphan', status: 'completed', background: false } } });
    },
    async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
    async listBackgroundTerminals() { return []; },
  }), () => {}, persistence('/tmp/unused-journals'));
  await controller.send('go');
  await assert.rejects(controller.previewRewind(controller.snapshot().turns[0]!.id), /子エージェント/);
  assert.equal(controller.hasLiveChildren(), true);
  assert.equal(forks, 0);
  controller.setTerminals([{ processId: 'p' }]);
  assert.equal(controller.hasLiveTerminals(), true);
  const quiet = new ChatController(selection(), async () => ({
    sessionId: 'thread-2',
    async run() {},
    async review(_target, emit) {
      emit({ id: 'orphan', role: 'status', text: 'done', meta: { type: 'subagent', subagent: { id: 'orphan', name: 'Orphan', status: 'completed', background: false } } });
    },
    async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
    async listBackgroundTerminals() { return []; },
  }), () => {}, persistence('/tmp/unused-journals'));
  await quiet.send('go');
  await quiet.review('uncommitted');
  assert.equal(quiet.snapshot().subagents[0]?.parentTurnId, undefined);
  await assert.rejects(quiet.previewRewind(quiet.snapshot().turns[0]!.id), /子エージェント/);
  quiet.setTerminals([{ processId: 'p', status: 'succeeded' }]);
  assert.equal(quiet.hasLiveTerminals(), false);
  const terminal = new ChatController(selection(), async () => ({
    async run() {}, async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
  }), () => {}, persistence('/tmp/unused-journals'));
  await terminal.send('go');
  terminal.setTerminals([{ processId: 'p', status: 'running' }]);
  await assert.rejects(terminal.previewRewind('x'), /Background Terminal/);
  assert.equal(forks, 0);
});

test('missing fork, backend ids, and resume targets fail before a second session', async () => {
  let opens = 0;
  const noFork = new ChatController(selection(), async () => {
    opens += 1;
    return { sessionId: 'thread-1', async run() {}, async dispose() {} };
  }, () => {}, persistence('/tmp/unused-journals'));
  await assert.rejects(noFork.previewRewind('x'), /再開できる Backend/);
  assert.equal(opens, 0);
  noFork.prepareResume('kept');
  await assert.rejects(noFork.previewRewind('x'), /安全な分岐/);
  assert.equal(opens, 1);
  let reason = 'maintenance';
  let forks = 0;
  const reasoned = new ChatController(selection(), async () => ({
    sessionId: 'thread-2',
    async run() {},
    async dispose() {},
    rewindUnsupportedReason: () => reason,
    async forkBeforeTurn(id: string) { forks += 1; return `branch-${id}`; },
    async listBackgroundTerminals() { return []; },
  }), () => {}, persistence('/tmp/unused-journals'));
  await reasoned.send('go');
  await assert.rejects(reasoned.previewRewind(reasoned.snapshot().turns[0]!.id), /maintenance/);
  assert.equal(forks, 0);
  reason = '';
  const unlisted = new ChatController(selection(), async () => ({
    sessionId: 'thread-3',
    async run() {},
    async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
  }), () => {}, persistence('/tmp/unused-journals'));
  await unlisted.send('go');
  await assert.rejects(unlisted.previewRewind(unlisted.snapshot().turns[0]!.id), /Background Terminal の状態を確認できない/);
  assert.equal(forks, 0);
  const ambiguous = new ChatController(selection(), async () => ({
    sessionId: 'thread-4',
    async run() { throw new Error('fail once'); },
    async dispose() {},
    async forkBeforeTurn() { forks += 1; return 'branch'; },
    async listBackgroundTerminals() { return []; },
    latestBackendTurnId: () => 'backend-turn',
  }), () => {}, persistence('/tmp/unused-journals'));
  await ambiguous.send('same');
  const first = ambiguous.snapshot().turns[0]!.id;
  await ambiguous.send('same', { retryOf: first });
  await assert.rejects(ambiguous.previewRewind(first), /一意に特定できません/);
  assert.equal(forks, 0);
  assert.equal(ambiguous.snapshot().turns.length, 2);
});

test('checkpoints reject outside, binary, rename, incomplete, and oversize turns without rewriting them', async () => {
  const dir = await workspace();
  const runs: string[] = [];
  let reason: string | undefined;
  const big = 'x'.repeat(1_000_000);
  try {
    await writeFile(path.join(dir.cwd, 'binary.txt'), Buffer.from([0x61, 0, 0x62]), { mode: 0o640 });
    await writeFile(path.join(dir.cwd, 'a.txt'), 'kept', { mode: 0o640 });
    let sessionId = 'thread-1';
    let controller!: ChatController;
    controller = new ChatController(selection(dir.cwd), async () => ({
      get sessionId() { return sessionId; },
      activateFork(id: string) { sessionId = id; },
      rewindUnsupportedReason: () => reason,
      latestBackendTurnId: () => 'backend-1',
      async listBackgroundTerminals() { return []; },
      async forkBeforeTurn(id: string) { return `branch-${id}`; },
      async run(prompt, _signal, emit) {
        runs.push(prompt);
        const files = (extra: import('../../src/types.js').FileChange[]) => {
          emit({ id: 'raw', role: 'tool', text: 'raw', meta: { type: 'files', files: extra } });
          emit({ id: 'workspace-changes:1', role: 'tool', text: 'final', meta: { type: 'files', files: extra } });
        };
        if (prompt === 'reason') return;
        if (prompt === 'rename') files([{ path: 'a.txt', kind: 'rename', oldPath: 'b.txt', previousText: 'kept', previousMode: fileMode }]);
        if (prompt === 'outside') files([{ path: dir.secret, kind: 'update', previousText: 'secret', previousMode: 0o640 }]);
        if (prompt === 'binary') files([{ path: 'binary.txt', kind: 'update', previousText: 'a', previousMode: 0o640 }]);
        if (prompt === 'disagree') files([{ path: 'a.txt', kind: 'update', previousText: null, previousMode: fileMode }]);
        if (prompt === 'incomplete') files([{ path: 'a.txt', kind: 'update', previousMode: fileMode }]);
        if (prompt === 'raw-missing') {
          emit({ id: 'raw', role: 'tool', text: 'raw', meta: { type: 'files', files: [{ path: 'extra.txt', kind: 'update' }] } });
          emit({ id: 'workspace-changes:1', role: 'tool', text: 'final', meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'kept', previousMode: 0o640 }] } });
        }
        if (prompt === 'oversize') {
          const half = 'h'.repeat(500_000);
          await writeFile(path.join(dir.cwd, 'p0.txt'), half, { mode: 0o640 });
          await writeFile(path.join(dir.cwd, 'p1.txt'), half, { mode: 0o640 });
          await writeFile(path.join(dir.cwd, 'p2.txt'), 'q', { mode: 0o640 });
          files([
            { path: 'p0.txt', kind: 'update', previousText: half, previousMode: fileMode },
            { path: 'p1.txt', kind: 'update', previousText: half, previousMode: fileMode },
            { path: 'p2.txt', kind: 'update', previousText: 'z', previousMode: fileMode },
          ]);
        }
        if (prompt.startsWith('chunk')) {
          await writeFile(path.join(dir.cwd, 'big.txt'), big, { mode: 0o640 });
          files([{ path: 'big.txt', kind: 'update', previousText: big, previousMode: fileMode }]);
        }
        if (prompt === 'good') files([{ path: 'a.txt', kind: 'update', previousText: 'before', previousMode: 0o640 }]);
      },
      async dispose() {},
    }), () => {}, persistence(dir.journals));
    reason = 'maintenance';
    await controller.send('reason');
    assert.equal(controller.snapshot().turns.at(-1)?.fileCheckpoint?.reason, 'maintenance');
    reason = undefined;
    for (const [prompt, pattern] of [
      ['rename', /Rename operations/],
      ['outside', /not safely restorable/],
      ['binary', /binary/],
      ['disagree', /baselines disagree/],
      ['incomplete', /before-state/],
      ['raw-missing', /extra\.txt/],
      ['oversize', /checkpoint size limit/],
    ] as const) {
      await controller.send(prompt);
      assert.match(controller.snapshot().turns.at(-1)?.fileCheckpoint?.reason ?? '', pattern);
      assert.equal(controller.snapshot().turns.at(-1)?.fileCheckpoint?.status, 'unsupported');
    }
    await controller.send('good');
    const good = controller.snapshot().turns.at(-1)!;
    assert.equal(good.fileCheckpoint?.status, 'captured');
    assert.equal(controller.rewindableTurnIds().has(good.id), true);
    const saved = controller.snapshot();
    delete saved.turns.at(-1)!.planBefore;
    controller.restoreSnapshot(saved, 'thread-1');
    await assert.rejects(controller.previewRewind(good.id), /チェックポイントが不足/);
    const messages = controller.snapshot();
    messages.messages = [];
    messages.turns = [good];
    controller.restoreSnapshot(messages, 'thread-1');
    await assert.rejects(controller.previewRewind(good.id), /missing from local history/);
    await assert.rejects(controller.rewindAndSend(good.id, 'edited'), /missing from local history/);
    assert.equal(sessionId, 'thread-1');
    assert.equal(runs.includes('edited'), false);
    assert.equal(await readFile(dir.secret, 'utf8'), 'secret');
    assert.equal((await stat(dir.secret)).mode & 0o777, 0o640);
    assert.equal((await stat(path.join(dir.cwd, 'binary.txt'))).mode & 0o777, 0o640);
    assert.equal(await readFile(path.join(dir.cwd, 'a.txt'), 'utf8'), 'kept');
    const half = 'h'.repeat(500_000);
    const heavy = new ChatController(selection(dir.cwd), async () => ({
      sessionId: 'heavy',
      async listBackgroundTerminals() { return []; },
      async forkBeforeTurn(id: string) { return `branch-${id}`; },
      async run(prompt, _signal, emit) {
        const tail = prompt === 'tail';
        await writeFile(path.join(dir.cwd, 'h0.txt'), tail ? 'z' : half, { mode: 0o640 });
        await writeFile(path.join(dir.cwd, 'h1.txt'), tail ? 'z' : half, { mode: 0o640 });
        const files = tail
          ? [{ path: 'h0.txt', kind: 'update' as const, previousText: 'y', previousMode: fileMode }]
          : [
            { path: 'h0.txt', kind: 'update' as const, previousText: half, previousMode: fileMode },
            { path: 'h1.txt', kind: 'update' as const, previousText: half, previousMode: fileMode },
          ];
        emit({ id: 'workspace-changes:1', role: 'tool', text: 'final', backendTurnId: prompt, meta: { type: 'files', files } });
      },
      async dispose() {},
    }), () => {}, persistence(dir.journals));
    for (const prompt of ['c1', 'c2', 'c3', 'c4']) await heavy.send(prompt);
    await heavy.send('tail');
    const turns = heavy.snapshot().turns;
    assert.equal(turns[3]?.fileCheckpoint?.status, 'captured');
    assert.match(turns[4]?.fileCheckpoint?.reason ?? '', /storage limit/);
    assert.equal(await readFile(dir.secret, 'utf8'), 'secret');
  } finally { await dir.cleanup(); }
});

test('rewind re-entry, journal rollback, and a closed branch leave files and the original session', async () => {
  const dir = await workspace();
  const runs: string[] = [];
  let sessionId = 'thread-1';
  let opens = 0;
  let forks = 0;
  let controller!: ChatController;
  controller = new ChatController(selection(dir.cwd), async () => {
    opens += 1;
    const session: AgentSession = {
      get sessionId() { return sessionId; },
      activateFork(id: string) { sessionId = id; },
      async listBackgroundTerminals() { return []; },
      async forkBeforeTurn() {
        forks += 1;
        if (forks === 1) {
          await assert.rejects(controller.rewindAndSend(controller.snapshot().turns[0]!.id, 'nested'), /既に実行中/);
          throw new Error('stop outer');
        }
        return `branch-${forks}`;
      },
      async run(prompt, _signal, emit) {
        runs.push(prompt);
        await writeFile(path.join(dir.cwd, 'a.txt'), 'after', { mode: 0o640 });
        emit({ id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: prompt === 'reenter' ? 'reenter' : 'backend-1', meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before', previousMode: 0o640 }] } });
        emit({ id: 'answer', role: 'assistant', text: 'ok', backendTurnId: prompt === 'reenter' ? 'reenter' : 'backend-1' });
      },
      async dispose() {},
    };
    return session;
  }, () => {}, persistence(dir.journals));
  try {
    await controller.send('reenter');
    const target = controller.snapshot().turns[0]!.id;
    await assert.rejects(controller.rewindAndSend(target, 'edited'), /stop outer/);
    assert.equal(sessionId, 'thread-1');
    assert.equal(forks, 1);
    assert.equal(opens, 1);
    assert.equal(runs.includes('edited') || runs.includes('nested'), false);
    assert.equal(await readFile(path.join(dir.cwd, 'a.txt'), 'utf8'), 'after');
    await chmod(dir.cwd, 0o555);
    await assert.rejects(controller.rewindAndSend(target, 'edited'), /EACCES|permission/i);
    await chmod(dir.cwd, 0o700);
    assert.equal(await readFile(path.join(dir.cwd, 'a.txt'), 'utf8'), 'after');
    assert.equal((await readdir(dir.journals).catch(() => [])).length, 0);
    assert.equal(sessionId, 'thread-1');
    assert.equal(runs.includes('edited'), false);
    let corrupt = false;
    let rollbackId = 'thread-rollback';
    const rollback = new ChatController(selection(dir.cwd), async () => ({
      get sessionId() { return rollbackId; },
      activateFork(id: string) { rollbackId = id; },
      async listBackgroundTerminals() { return []; },
      async forkBeforeTurn() { return 'branch-rollback'; },
      async run(prompt, _signal, emit) {
        runs.push(prompt);
        emit({ id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: 'backend-rollback', meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before', previousMode: 0o640 }] } });
        emit({ id: 'answer', role: 'assistant', text: 'ok', backendTurnId: 'backend-rollback' });
      },
      async dispose() {},
    }), (state) => {
      if (!corrupt && state.operationLabel === 'rewind-files') {
        corrupt = true;
        writeFileSync(path.join(dir.cwd, 'a.txt'), 'third');
      }
      if (state.operationLabel === 'rewind-check') rollback.setTerminals([{ processId: 'ignored', status: 'running' }]);
    }, persistence(dir.journals));
    await rollback.send('rollback');
    await assert.rejects(rollback.rewindAndSend(rollback.snapshot().turns[0]!.id, 'edited'), /復旧に失敗しました/);
    assert.equal(await readFile(path.join(dir.cwd, 'a.txt'), 'utf8'), 'third');
    assert.equal((await stat(path.join(dir.cwd, 'a.txt'))).mode & 0o777, 0o640);
    assert.equal((await readdir(dir.journals)).some((name) => name.endsWith('.json')), true);
    assert.equal(rollbackId, 'thread-rollback');
    assert.equal(runs.includes('edited'), false);
    assert.equal(rollback.snapshot().terminals.length, 0);
    assert.equal(await readFile(dir.secret, 'utf8'), 'secret');
    assert.equal((await stat(dir.secret)).mode & 0o777, 0o640);
  } finally { await dir.cleanup(); }
});

test('an empty branch id and a closed branch do not send or keep a second session', async () => {
  const dir = await workspace();
  const runs: string[] = [];
  let opens = 0;
  let mode: 'empty' | 'closed' | 'missing-id' = 'empty';
  let sessionId = 'thread-1';
  let closed = false;
  try {
    await writeFile(path.join(dir.cwd, 'a.txt'), 'after', { mode: 0o640 });
    const controller = new ChatController(selection(dir.cwd), async () => {
      opens += 1;
      return {
        get sessionId() { return sessionId; },
        get closed() { return closed; },
        activateFork(id: string) { sessionId = id; closed = mode === 'closed' && id !== 'thread-1'; },
        async listBackgroundTerminals() { return []; },
        async forkBeforeTurn() { return mode === 'empty' ? '' : 'branch-next'; },
        async run(_prompt, _signal, emit) {
          runs.push(_prompt);
          emit({ id: 'workspace-changes:1', role: 'tool', text: 'a', backendTurnId: 'backend-1', meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before', previousMode: 0o640 }] } });
        },
        async dispose() {},
      };
    }, () => {}, { ...persistence(dir.journals), conversationId: () => mode === 'missing-id' ? undefined : 'conversation-1' });
    await controller.send('once');
    const target = controller.snapshot().turns[0]!.id;
    await assert.rejects(controller.rewindAndSend(target, 'edited'), /separate conversation branch/);
    mode = 'closed';
    await assert.rejects(controller.rewindAndSend(target, 'edited'), /could not be opened safely/);
    assert.equal(sessionId, 'thread-1');
    assert.equal(closed, false);
    mode = 'missing-id';
    await assert.rejects(controller.rewindAndSend(target, 'edited'), /conversation id is not available/);
    assert.equal(sessionId, 'thread-1');
    assert.equal(runs.includes('edited'), false);
    assert.equal(await readFile(path.join(dir.cwd, 'a.txt'), 'utf8'), 'after');
    assert.equal(opens, 1);
    assert.equal(await readFile(dir.secret, 'utf8'), 'secret');
  } finally { await dir.cleanup(); }
});
