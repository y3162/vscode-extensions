import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController, type RewindPersistence } from '../src/chat-controller.js';
import type { AgentSession, AgentUpdate, TerminalRecord } from '../src/types.js';

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
}) {
  let sessionId = 'thread-1';
  const runs: string[] = [];
  let opens = 0;
  const session: AgentSession = {
    get sessionId() { return sessionId; },
    async listBackgroundTerminals() { return options?.terminals?.() ?? []; },
    async forkBeforeTurn(id: string) {
      return options?.fork ? await options.fork(id, sessionId) : `branch-${id}`;
    },
    async run(prompt, _signal, emit) {
      runs.push(prompt);
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
    enabled: () => true,
    flush: async () => { flushes += 1; if (options?.flush) await options.flush(flushes); },
  };
  const controller = new ChatController({ provider: 'codex', cwd, model: 'fixture' }, async () => {
    opens += 1;
    if (opens > 1 && options?.factoryError) throw new Error(options.factoryError);
    return session;
  }, () => {}, persistence);
  return { controller, runs, sessionId: () => sessionId };
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
