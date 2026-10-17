import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController, type RewindPersistence } from '../../src/chat-controller.js';
import type { AgentSession, AgentUpdate, ChatState, TerminalRecord } from '../../src/types.js';

const mode = 0o644;

async function directory(): Promise<{ cwd: string; journals: string; cleanup: () => Promise<void> }> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-controller-')));
  const journals = path.join(path.dirname(cwd), `journals-${path.basename(cwd)}`);
  return { cwd, journals, cleanup: async () => { await chmod(cwd, 0o700).catch(() => undefined); await rm(cwd, { recursive: true, force: true }); await rm(journals, { recursive: true, force: true }); } };
}

interface Script {
  before: string | null;
  after: string;
  backendTurnId: string;
  todos?: { content: string; status: string }[];
  plan?: string;
  subagent?: string;
  usage?: number;
}

function harness(cwd: string, journals: string, scripts: Record<string, Script>, options?: {
  fork?: (id: string, current: string) => string | Promise<string>;
  activate?: boolean;
  terminals?: () => TerminalRecord[];
  flush?: (count: number) => Promise<void>;
  factoryError?: string;
  branchSessionWithoutTerminalList?: boolean;
  rewindEnabled?: boolean;
  holdPrompt?: string;
  runGate?: Promise<void>;
  onRunStart?: () => void;
  onState?: (state: ChatState) => void;
}) {
  let sessionId = 'thread-1';
  const runs: string[] = [];
  let opens = 0;
  let branchDisposals = 0;
  const session: AgentSession = {
    get sessionId() { return sessionId; },
    async listBackgroundTerminals() { return options?.terminals?.() ?? []; },
    async forkBeforeTurn(id: string) {
      return options?.fork ? await options.fork(id, sessionId) : `branch-${id}`;
    },
    async run(prompt, _signal, emit) {
      runs.push(prompt);
      if (prompt === options?.holdPrompt) { options.onRunStart?.(); await options.runGate; }
      const script = scripts[prompt];
      if (!script) {
        emit({ id: 'answer', role: 'assistant', text: `answer:${prompt}`, backendTurnId: `reply-${runs.length}` });
        return;
      }
      const file = path.join(cwd, 'a.txt');
      await writeFile(file, script.after, { mode });
      await chmod(file, mode);
      emit({
        id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: script.backendTurnId,
        meta: { type: 'files', files: [{ path: 'a.txt', kind: script.before === null ? 'add' : 'update', previousText: script.before, previousMode: script.before === null ? null : mode }] },
      });
      emit({ id: 'answer', role: 'assistant', text: `answer:${prompt}`, backendTurnId: script.backendTurnId });
      if (script.plan) emit({ id: 'plan', role: 'status', text: script.plan, meta: { type: 'plan', plan: { markdown: script.plan, source: 'assistant-text' } } });
      if (script.todos) emit({ id: 'todos', role: 'status', text: script.todos.map((todo) => todo.content).join('\n'), meta: { type: 'todo', todos: script.todos } });
      if (script.subagent) emit({ id: `sub:${script.subagent}`, role: 'status', text: script.subagent, meta: { type: 'subagent', subagent: { id: script.subagent, name: script.subagent, status: 'completed', background: false } } });
      if (script.usage !== undefined) emit({ id: `usage-${script.backendTurnId}`, role: 'status', text: '', meta: { type: 'usage', usage: { inputTokens: script.usage, outputTokens: 1, totalTokens: script.usage + 1, scope: 'request', source: 'test' } } });
    },
    async dispose() {},
  };
  if (options?.activate !== false) session.activateFork = (id: string) => { sessionId = id; };
  let flushes = 0;
  const persistence: RewindPersistence = {
    journalDirectory: journals,
    conversationId: () => 'conversation-1',
    enabled: () => options?.rewindEnabled ?? true,
    flush: async () => { flushes += 1; if (options?.flush) await options.flush(flushes); },
  };
  const controller = new ChatController({ provider: 'codex', cwd, model: 'fixture' }, async (_selection, openOptions) => {
    opens += 1;
    if (opens > 1 && options?.branchSessionWithoutTerminalList) {
      return { sessionId: openOptions?.resumeId, async run() { throw new Error('branch run must not start'); }, async dispose() { branchDisposals += 1; } };
    }
    if (opens > 1 && options?.factoryError) throw new Error(options.factoryError);
    return session;
  }, (state) => options?.onState?.(state), persistence);
  return { controller, runs, sessionId: () => sessionId, branchDisposals: () => branchDisposals };
}

const story: Record<string, Script> = {
  one: { before: null, after: 'one\n', backendTurnId: 'b1', usage: 2 },
  two: { before: 'one\n', after: 'two\n', backendTurnId: 'b2', usage: 3, todos: [{ content: 'keep', status: 'pending' }], plan: 'early plan', subagent: 'kept' },
  three: { before: 'two\n', after: 'three\n', backendTurnId: 'b3', usage: 4, todos: [{ content: 'drop', status: 'completed' }], plan: 'late plan', subagent: 'dropped' },
};

async function play(cwd: string, journals: string, options?: Parameters<typeof harness>[3]) {
  const built = harness(cwd, journals, story, options);
  await built.controller.send('one');
  await built.controller.send('two');
  await built.controller.send('three');
  return built;
}

test('a failed file restore leaves the conversation and files unchanged and does not send', async () => {
  const workspace = await directory();
  try {
    const { controller, runs } = await play(workspace.cwd, workspace.journals);
    const before = controller.snapshot();
    await chmod(workspace.cwd, 0o555);
    await assert.rejects(controller.rewindAndSend(before.turns[0]!.id, 'edited'), /EACCES|permission/i);
    await chmod(workspace.cwd, 0o700);
    const after = controller.snapshot();
    assert.deepEqual(after.messages.map((message) => message.text), before.messages.map((message) => message.text));
    assert.deepEqual(after.turns.map((turn) => turn.id), before.turns.map((turn) => turn.id));
    assert.equal(controller.sessionId(), 'thread-1');
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(runs.includes('edited'), false);
    assert.equal(after.busy, false);
  } finally { await workspace.cleanup(); }
});

test('a reopened branch must expose terminal state before a rewind can change files or send', async () => {
  const workspace = await directory();
  try {
    const built = await play(workspace.cwd, workspace.journals, { activate: false, branchSessionWithoutTerminalList: true });
    const before = built.controller.snapshot();
    await assert.rejects(built.controller.rewindAndSend(before.turns[0]!.id, 'edited'), /Background Terminal/);
    assert.deepEqual(built.controller.snapshot().turns.map((turn) => turn.id), before.turns.map((turn) => turn.id));
    assert.equal(built.sessionId(), 'thread-1');
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(built.runs.includes('edited'), false);
    assert.equal(built.branchDisposals(), 1);
  } finally { await workspace.cleanup(); }
});

test('a successful rewind switches to a separately reopened branch and disposes the prior session', async () => {
  const workspace = await directory();
  const filePath = path.join(workspace.cwd, 'a.txt');
  let opens = 0;
  let resumeId: string | undefined;
  let oldDisposals = 0;
  let branchDisposals = 0;
  let oldUnsubscribes = 0;
  let branchUnsubscribes = 0;
  const branchPrompts: string[] = [];
  const oldSession: AgentSession = {
    sessionId: 'thread-1',
    subscribeBackgroundUpdates() { return () => { oldUnsubscribes += 1; }; },
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id) { return `branch-${id}`; },
    async run(prompt, _signal, emit) {
      assert.equal(prompt, 'original');
      await writeFile(filePath, 'after\n', { mode });
      await chmod(filePath, mode);
      emit({
        id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: 'backend-1',
        meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before\n', previousMode: mode }] },
      });
      emit({ id: 'answer:original', role: 'assistant', text: 'original answer', backendTurnId: 'backend-1', final: true });
    },
    async dispose() { oldDisposals += 1; throw new Error('old session close failed'); },
  };
  const branchSession: AgentSession = {
    sessionId: 'branch-backend-1',
    subscribeBackgroundUpdates() { return () => { branchUnsubscribes += 1; }; },
    async listBackgroundTerminals() { return null as unknown as TerminalRecord[]; },
    async run(prompt, _signal, emit) {
      branchPrompts.push(prompt);
      emit({ id: 'answer:edited', role: 'assistant', text: 'edited answer', backendTurnId: 'backend-edited', final: true });
    },
    async dispose() { branchDisposals += 1; },
  };
  const controller = new ChatController({ provider: 'codex', cwd: workspace.cwd, model: 'fixture' }, async (_selection, context) => {
    opens += 1;
    if (opens === 1) return oldSession;
    resumeId = context?.resumeId;
    return branchSession;
  }, () => {}, {
    journalDirectory: workspace.journals,
    conversationId: () => 'conversation-1',
    enabled: () => true,
    flush: async () => {},
  });

  try {
    await writeFile(filePath, 'before\n', { mode });
    await controller.send('original');
    const target = controller.snapshot().turns[0]!.id;
    assert.equal(await readFile(filePath, 'utf8'), 'after\n');

    await controller.rewindAndSend(target, 'edited');

    const state = controller.snapshot();
    assert.equal(opens, 2);
    assert.equal(resumeId, 'branch-backend-1');
    assert.equal(controller.currentSession(), branchSession);
    assert.equal(controller.sessionId(), 'branch-backend-1');
    assert.deepEqual(branchPrompts, ['edited']);
    assert.equal(await readFile(filePath, 'utf8'), 'before\n');
    assert.equal(oldDisposals, 1, 'the old session is disposed after the new branch accepts the edited prompt');
    assert.equal(oldUnsubscribes, 1, 'background events from the old session are detached when the branch becomes active');
    assert.equal(branchDisposals, 0, 'the active branch remains open');
    assert.equal(branchUnsubscribes, 0, 'background events remain attached to the active branch');
    assert.equal(state.messages.some((message) => message.text === 'edited answer'), true);
    assert.equal(state.messages.some((message) => message.text === 'original answer'), false);
    assert.equal(state.busy, false);
    assert.equal(state.status, 'idle');

    await controller.dispose();
    assert.equal(branchDisposals, 1, 'disposing the controller closes the active branch');
    assert.equal(branchUnsubscribes, 1, 'disposing the controller detaches the active branch listener');
  } finally {
    await controller.dispose();
    await workspace.cleanup();
  }
});

test('a persistence failure after switching branches restores the old session and its files', async () => {
  const workspace = await directory();
  const filePath = path.join(workspace.cwd, 'a.txt');
  let opens = 0;
  let flushes = 0;
  let oldDisposals = 0;
  let branchDisposals = 0;
  let oldUnsubscribes = 0;
  let branchUnsubscribes = 0;
  const oldSession: AgentSession = {
    sessionId: 'thread-1',
    subscribeBackgroundUpdates() { return () => { oldUnsubscribes += 1; }; },
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id) { return `branch-${id}`; },
    async run(_prompt, _signal, emit) {
      await writeFile(filePath, 'after\n', { mode });
      await chmod(filePath, mode);
      emit({ id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: 'backend-1',
        meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before\n', previousMode: mode }] } });
      emit({ id: 'answer:original', role: 'assistant', text: 'original answer', backendTurnId: 'backend-1', final: true });
    },
    async dispose() { oldDisposals += 1; },
  };
  const branchSession: AgentSession = {
    sessionId: 'branch-backend-1',
    subscribeBackgroundUpdates() { return () => { branchUnsubscribes += 1; }; },
    async listBackgroundTerminals() { return []; },
    async run() { assert.fail('edited prompt must not run before the persistence flush succeeds'); },
    async dispose() { branchDisposals += 1; },
  };
  const controller = new ChatController({ provider: 'codex', cwd: workspace.cwd, model: 'fixture' }, async (_selection, context) => {
    opens += 1;
    if (opens === 1) return oldSession;
    assert.equal(context?.resumeId, 'branch-backend-1');
    return branchSession;
  }, () => {}, {
    journalDirectory: workspace.journals,
    conversationId: () => 'conversation-1',
    enabled: () => true,
    async flush() {
      flushes += 1;
      if (flushes === 2) throw new Error('rewind state flush failed');
    },
  });

  try {
    await writeFile(filePath, 'before\n', { mode });
    await controller.send('original');
    const before = controller.snapshot();
    await assert.rejects(controller.rewindAndSend(before.turns[0]!.id, 'edited'), /rewind state flush failed/);

    const after = controller.snapshot();
    assert.equal(controller.currentSession(), oldSession);
    assert.equal(controller.sessionId(), 'thread-1');
    assert.deepEqual(after.turns.map((turn) => turn.id), before.turns.map((turn) => turn.id));
    assert.deepEqual(after.messages.map((message) => message.text), before.messages.map((message) => message.text));
    assert.equal(await readFile(filePath, 'utf8'), 'after\n');
    assert.equal(opens, 2);
    assert.equal(flushes, 3, 'the recovery flush is attempted after restoring the original state');
    assert.equal(oldDisposals, 0, 'the prior session stays alive after recovery');
    assert.equal(branchDisposals, 1, 'the abandoned branch session is disposed');
    assert.equal(oldUnsubscribes, 1, 'branch switching detaches the old event listener');
    assert.equal(branchUnsubscribes, 1, 'rollback detaches the failed branch event listener');
    assert.equal(after.busy, false);
    assert.equal(after.status, 'idle');
    assert.equal((await readdir(workspace.journals)).length, 0, 'successful rollback removes the recovery journal');
  } finally {
    await controller.dispose();
    assert.equal(oldDisposals, 1, 'controller cleanup disposes the restored session');
    assert.equal(oldUnsubscribes, 2, 'controller cleanup detaches the restored listener');
    await workspace.cleanup();
  }
});

test('a rollback conflict after switching branches preserves an external edit and recovery journal', async () => {
  const workspace = await directory();
  const filePath = path.join(workspace.cwd, 'a.txt');
  let opens = 0;
  let flushes = 0;
  let branchDisposals = 0;
  let externalEditInjected = false;
  const oldSession: AgentSession = {
    sessionId: 'thread-1',
    async listBackgroundTerminals() { return []; },
    async forkBeforeTurn(id) { return `branch-${id}`; },
    async run(_prompt, _signal, emit) {
      await writeFile(filePath, 'after\n', { mode });
      await chmod(filePath, mode);
      emit({ id: 'workspace-changes:1', role: 'tool', text: 'a.txt', backendTurnId: 'backend-1',
        meta: { type: 'files', files: [{ path: 'a.txt', kind: 'update', previousText: 'before\n', previousMode: mode }] } });
      emit({ id: 'answer:original', role: 'assistant', text: 'original answer', backendTurnId: 'backend-1', final: true });
    },
    async dispose() {},
  };
  const branchSession: AgentSession = {
    sessionId: 'branch-backend-1',
    async listBackgroundTerminals() { return []; },
    async run() { assert.fail('the edited prompt must not run after a persistence failure'); },
    async dispose() { branchDisposals += 1; },
  };
  const controller = new ChatController({ provider: 'codex', cwd: workspace.cwd, model: 'fixture' }, async (_selection, context) => {
    opens += 1;
    if (opens === 1) return oldSession;
    assert.equal(context?.resumeId, 'branch-backend-1');
    return branchSession;
  }, (state) => {
    if (!externalEditInjected && state.operationLabel === 'rewind-prepare') {
      externalEditInjected = true;
      writeFileSync(filePath, 'external change\n');
    }
  }, {
    journalDirectory: workspace.journals,
    conversationId: () => 'conversation-1',
    enabled: () => true,
    async flush() {
      flushes += 1;
      if (flushes === 2) throw new Error('rewind state flush failed');
    },
  });

  try {
    await writeFile(filePath, 'before\n', { mode });
    await controller.send('original');
    const before = controller.snapshot();
    await assert.rejects(controller.rewindAndSend(before.turns[0]!.id, 'edited'), /rewind state flush failed[\s\S]*復旧に失敗しました/);

    const after = controller.snapshot();
    assert.equal(externalEditInjected, true);
    assert.equal(await readFile(filePath, 'utf8'), 'external change\n', 'recovery does not overwrite a concurrent workspace edit');
    assert.equal(controller.currentSession(), oldSession);
    assert.equal(controller.sessionId(), 'thread-1');
    assert.deepEqual(after.turns.map((turn) => turn.id), before.turns.map((turn) => turn.id));
    assert.deepEqual(after.messages.map((message) => message.text), before.messages.map((message) => message.text));
    assert.equal(opens, 2);
    assert.equal(flushes, 3);
    assert.equal(branchDisposals, 1);
    const journalFiles = await readdir(workspace.journals);
    assert.equal(journalFiles.some((name) => name.endsWith('.json')), true, 'the journal is kept for manual recovery');
    assert.equal(after.busy, false);
    assert.equal(after.status, 'idle');
  } finally {
    await controller.dispose();
    await workspace.cleanup();
  }
});

test('rewind locks every session and turn mutation until the replacement turn is ready', async () => {
  const workspace = await directory();
  const blocked: Promise<void>[] = [];
  let built!: ReturnType<typeof harness>;
  let checked = false;
  try {
    built = harness(workspace.cwd, workspace.journals, story, {
      onState(state) {
        if (checked || state.operationLabel !== 'rewind-check') return;
        checked = true;
        const { controller } = built;
        const selection = { provider: 'codex', cwd: workspace.cwd, model: 'other' } as const;
        blocked.push(assert.rejects(controller.select(selection), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.updateSelection(selection), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.review('base'), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.applyMode('plan'), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.build('missing', 1, selection), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.sendQueued('missing'), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.steerQueued('missing'), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.send('must-not-run'), /エージェントは実行中/));
        blocked.push(assert.rejects(controller.openSession(), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.reset(), /巻き戻し処理中/));
        blocked.push(assert.rejects(controller.rewindAndSend('nested', 'must-not-run'), /巻き戻し処理/));
        assert.throws(() => controller.setBuildModel(selection), /巻き戻し処理中/);
        assert.throws(() => controller.enqueue('must-not-queue'), /巻き戻し処理中/);
        const planBefore = controller.planSnapshot();
        controller.restorePlan({ phase: 'ready', revisions: [], current: { id: 'restored', revision: 1, markdown: 'must not replace', todos: [], source: 'assistant-text', createdAt: 0 } });
        controller.removeQueued('missing');
        assert.deepEqual(controller.planSnapshot(), planBefore);
      },
    });
    await built.controller.send('one');
    await built.controller.send('two');
    await built.controller.send('three');
    const target = built.controller.snapshot().turns[0]!.id;
    await built.controller.rewindAndSend(target, 'edited');

    await Promise.all(blocked);
    const state = built.controller.snapshot();
    assert.equal(checked, true);
    assert.deepEqual(built.runs, ['one', 'two', 'three', 'edited']);
    assert.equal(state.queue.length, 0);
    assert.equal(state.busy, false);
    assert.equal(state.status, 'idle');
    assert.equal(built.controller.sessionId(), 'branch-b1');
  } finally {
    if (built) await built.controller.dispose();
    await workspace.cleanup();
  }
});

test('rewindable turn ids stop at the first unsafe boundary and require an idle safe session', async () => {
  const workspace = await directory();
  try {
    const built = await play(workspace.cwd, workspace.journals);
    const controller = built.controller;
    const base = controller.snapshot();
    const expected = base.turns.map((turn) => turn.id).reverse();
    assert.deepEqual([...controller.rewindableTurnIds()], expected);

    const unsafeOlder = structuredClone(base);
    unsafeOlder.turns[0]!.userMessageId = 'retry-boundary';
    controller.restoreSnapshot(unsafeOlder, 'thread-1');
    assert.deepEqual([...controller.rewindableTurnIds()], expected.slice(0, -1));

    const unsafeLatest = structuredClone(base);
    unsafeLatest.turns.at(-1)!.fileCheckpoint = { status: 'unsupported', files: [], reason: 'fixture' };
    controller.restoreSnapshot(unsafeLatest, 'thread-1');
    assert.deepEqual([...controller.rewindableTurnIds()], []);

    for (const state of [
      { ...base, subagents: [{ id: 'child', name: 'child', status: 'running' as const, background: true }] },
      { ...base, terminals: [{ processId: 'terminal', status: 'running' }] },
    ]) {
      controller.restoreSnapshot(structuredClone(state), 'thread-1');
      assert.deepEqual([...controller.rewindableTurnIds()], []);
    }

    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedRun = new Promise<void>((resolve) => { started = resolve; });
    const held = await play(workspace.cwd, path.join(workspace.journals, 'held'), { holdPrompt: 'hold', runGate: gate, onRunStart: started });
    const running = held.controller.send('hold');
    await startedRun;
    assert.deepEqual([...held.controller.rewindableTurnIds()], []);
    held.controller.enqueue('queued');
    assert.deepEqual([...held.controller.rewindableTurnIds()], []);
    release();
    await running;

    const disabledWorkspace = await directory();
    try {
      const disabled = await play(disabledWorkspace.cwd, disabledWorkspace.journals, { rewindEnabled: false });
      assert.deepEqual([...disabled.controller.rewindableTurnIds()], []);
    } finally { await disabledWorkspace.cleanup(); }
  } finally { await workspace.cleanup(); }
});

test('a flush failure after switching rolls the conversation and files back', async () => {
  const workspace = await directory();
  try {
    const { controller, runs, sessionId } = await play(workspace.cwd, workspace.journals, {
      flush: async (count) => { if (count >= 2) throw new Error('flush failed'); },
    });
    const before = controller.snapshot();
    await assert.rejects(controller.rewindAndSend(before.turns[0]!.id, 'edited'), /flush failed/);
    assert.deepEqual(controller.snapshot().messages.map((message) => message.text), before.messages.map((message) => message.text));
    assert.deepEqual(controller.snapshot().turns.map((turn) => turn.id), before.turns.map((turn) => turn.id));
    assert.equal(sessionId(), 'thread-1');
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(runs.includes('edited'), false);
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().status, 'idle');
    assert.equal(controller.snapshot().operationLabel, undefined);
    assert.deepEqual(await readdir(workspace.journals), []);
  } finally { await workspace.cleanup(); }
});

test('a fork failure does not send or change files', async () => {
  const workspace = await directory();
  try {
    const { controller, runs } = await play(workspace.cwd, workspace.journals, {
      fork: async () => { throw new Error('fork refused'); },
    });
    const before = controller.snapshot();
    await assert.rejects(controller.rewindAndSend(before.turns[1]!.id, 'edited'), /fork refused/);
    assert.equal(controller.snapshot().messages.length, before.messages.length);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(runs.at(-1), 'three');
  } finally { await workspace.cleanup(); }
});

test('a branch id equal to the current session does not send', async () => {
  const workspace = await directory();
  try {
    const { controller, runs } = await play(workspace.cwd, workspace.journals, {
      fork: async (_id, current) => current,
    });
    await assert.rejects(controller.rewindAndSend(controller.snapshot().turns[2]!.id, 'edited'), /separate conversation branch/);
    assert.equal(runs.includes('edited'), false);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
  } finally { await workspace.cleanup(); }
});

test('a live terminal on the new branch cancels rewind before files change', async () => {
  const workspace = await directory();
  try {
    let calls = 0;
    const { controller, runs } = await play(workspace.cwd, workspace.journals, {
      terminals: () => {
        calls += 1;
        return calls < 2 ? [] : [{ processId: 'live', status: 'running' }];
      },
    });
    await assert.rejects(controller.rewindAndSend(controller.snapshot().turns[2]!.id, 'edited'), /live background terminal/);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(runs.includes('edited'), false);
  } finally { await workspace.cleanup(); }
});

test('opening the branch failing does not send', async () => {
  const workspace = await directory();
  try {
    const { controller, runs } = await play(workspace.cwd, workspace.journals, {
      activate: false,
      fork: async (id) => `branch-${id}`,
      factoryError: 'branch open failed',
    });
    await assert.rejects(controller.rewindAndSend(controller.snapshot().turns[0]!.id, 'edited'), /branch open failed/);
    assert.equal(runs.includes('edited'), false);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'three\n');
    assert.equal(controller.sessionId(), 'thread-1');
  } finally { await workspace.cleanup(); }
});

test('rewinding the first user turn drops later messages, files, usage, and child cards', async () => {
  const workspace = await directory();
  try {
    const { controller, runs, sessionId } = await play(workspace.cwd, workspace.journals);
    const first = controller.snapshot().turns[0]!.id;
    await controller.rewindAndSend(first, 'edited-one');
    const state = controller.snapshot();
    assert.deepEqual(state.messages.filter((message) => message.role === 'user').map((message) => message.text), ['edited-one']);
    assert.equal(state.turns.length, 1);
    assert.equal(state.usage, null);
    assert.deepEqual(state.todos, []);
    assert.deepEqual(state.subagents, []);
    assert.equal(sessionId(), 'branch-b1');
    await assert.rejects(readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), { code: 'ENOENT' });
    assert.equal(runs.at(-1), 'edited-one');
  } finally { await workspace.cleanup(); }
});

test('rewinding the last user turn keeps earlier plan, usage, and child state', async () => {
  const workspace = await directory();
  try {
    const { controller, sessionId } = await play(workspace.cwd, workspace.journals);
    const last = controller.snapshot().turns[2]!.id;
    await controller.rewindAndSend(last, 'edited-last');
    const state = controller.snapshot();
    assert.deepEqual(state.messages.filter((message) => message.role === 'user').map((message) => message.text), ['one', 'two', 'edited-last']);
    assert.equal(state.turns.length, 3);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(state.todos[0]?.content, 'keep');
    assert.equal(state.plan.draft?.markdown, 'early plan');
    assert.deepEqual(state.subagents.map((child) => child.id), ['kept']);
    assert.equal(state.usage?.inputTokens, 5);
    assert.equal(sessionId(), 'branch-b3');
    assert.equal(state.messages.some((message) => message.text === 'answer:three'), false);
  } finally { await workspace.cleanup(); }
});

test('rewinding the middle user turn removes only the following turn', async () => {
  const workspace = await directory();
  try {
    const { controller } = await play(workspace.cwd, workspace.journals);
    const middle = controller.snapshot().turns[1]!.id;
    await controller.rewindAndSend(middle, 'edited-middle');
    const state = controller.snapshot();
    assert.deepEqual(state.messages.filter((message) => message.role === 'user').map((message) => message.text), ['one', 'edited-middle']);
    assert.equal(await readFile(path.join(workspace.cwd, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(state.subagents.length, 0);
    assert.equal(state.usage?.inputTokens, 2);
  } finally { await workspace.cleanup(); }
});

test('rewinding a deletion restores the file baseline and drops patch-only rows from the review list', async () => {
  const workspace = await directory();
  const filePath = path.join(workspace.cwd, 'note.txt');
  let sessionId = 'thread-1';
  try {
    const controller = new ChatController({ provider: 'codex', cwd: workspace.cwd, model: 'fixture' }, async () => ({
      get sessionId() { return sessionId; },
      activateFork(id: string) { sessionId = id; },
      async listBackgroundTerminals() { return []; },
      async forkBeforeTurn(id: string) { return `branch-${id}`; },
      async run(prompt, _signal, emit) {
        if (prompt === 'add') {
          await writeFile(filePath, 'first state\n', { mode });
          emit({ id: 'workspace-changes:1', backendTurnId: 'backend-1', role: 'tool', text: 'files', meta: { type: 'files', files: [
            { path: 'note.txt', kind: 'add', previousText: null, previousMode: null },
            { path: 'patch', kind: 'update', previousText: null, previousMode: null },
            { path: 'turn.diff', kind: 'update', previousText: null, previousMode: null },
          ] } });
        } else if (prompt === 'delete') {
          await rm(filePath);
          emit({ id: 'workspace-changes:2', backendTurnId: 'backend-2', role: 'tool', text: 'files', meta: { type: 'files', files: [
            { path: 'note.txt', kind: 'delete', previousText: 'first state\n', previousMode: mode },
          ] } });
        }
      },
      async dispose() {},
    }), () => {}, {
      journalDirectory: workspace.journals,
      conversationId: () => 'conversation-1',
      enabled: () => true,
      flush: async () => {},
    });

    await controller.send('add');
    await controller.send('delete');
    const target = controller.snapshot().turns[1]!.id;
    assert.equal(controller.snapshot().changes.find((change) => change.path.endsWith('note.txt'))?.kind, 'delete');
    assert.equal(controller.snapshot().changes.some((change) => change.path === 'patch' || change.path === 'turn.diff'), true);

    await controller.rewindAndSend(target, 'edited deletion');
    const state = controller.snapshot();
    assert.equal(await readFile(filePath, 'utf8'), 'first state\n');
    assert.deepEqual(state.changes.map(({ path: changePath, kind, previousText, additions, deletions }) => ({
      path: path.basename(changePath), kind, previousText, additions, deletions,
    })), [{ path: 'note.txt', kind: 'add', previousText: null, additions: 1, deletions: 0 }]);
    assert.equal(state.turns.length, 2, 'the replacement turn follows the retained first turn');
    assert.equal(state.turns[0]?.fileCheckpoint?.status, 'captured');
    assert.equal(state.busy, false);
  } finally {
    await workspace.cleanup();
  }
});
