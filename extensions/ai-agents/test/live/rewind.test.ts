import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { HistoryStore } from '../../src/history-store.js';
import { createSession } from '../../src/providers/index.js';
import type { AgentSession, ChatMessage, ChatState, Selection } from '../../src/types.js';
import { createGitFixture, snapshotGitFixture } from '../support/git-fixture.js';

const enabled = process.env.AI_AGENTS_LIVE_REWIND === '1';
const controls = {
  backend: 'app-server' as const,
  mode: 'agent' as const,
  sandbox: 'workspace-write',
  approval: 'never',
  network: false,
  webSearch: '',
  additionalDirectories: [] as string[],
};
const interactions = {
  requestPermission: async () => 'deny' as const,
  requestPlan: async () => 'rejected' as const,
  requestAnswers: async () => ({}),
};

interface Fixture {
  cwd: string;
  storage: string;
  conversationId: string;
  history: HistoryStore;
  controller: ChatController;
  captureBeforeReplay(files: string[]): Promise<Record<string, string | null>>;
  close(): Promise<void>;
}

async function fixture(label: string): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), `ai-agents-rewind-${label}-`));
  const storage = await mkdtemp(path.join(tmpdir(), 'ai-agents-rewind-store-'));
  await writeFile(path.join(cwd, 'seed.txt'), 'seed\n');
  createGitFixture(cwd);
  snapshotGitFixture(cwd);

  const history = new HistoryStore(path.join(storage, 'history'));
  await history.load();
  const conversationId = randomUUID();
  let controller!: ChatController;
  let prepareWaiter: { files: string[]; resolve(value: Record<string, string | null>): void; reject(error: unknown): void } | undefined;
  const selection: Selection = { provider: 'codex', cwd, model: 'gpt-6-luna', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] };
  const persistence = {
    journalDirectory: path.join(storage, 'rewind-journals'),
    conversationId: () => conversationId,
    enabled: () => true,
    flush: () => history.flush(),
  };
  controller = new ChatController(selection, async (next, context) => createSession({
    ...next,
    ...controls,
    storagePath: path.join(storage, 'cursor-agents'),
    resumeId: context?.resumeId,
    signal: context?.signal,
    interactions: controller.interactions,
  }), (state) => {
    if (state.operationLabel === 'rewind-prepare' && prepareWaiter) {
      const waiter = prepareWaiter;
      prepareWaiter = undefined;
      void Promise.all(waiter.files.map(async (file) => {
        try { return await readFile(file, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      })).then((values) => waiter.resolve(Object.fromEntries(waiter.files.map((file, index) => [file, values[index]!])))).catch(waiter.reject);
    }
    save(history, conversationId, controller, state);
  }, persistence);

  return {
    cwd, storage, conversationId, history, controller,
    captureBeforeReplay(files) {
      assert.equal(prepareWaiter, undefined, 'only one rewind capture is expected for each fixture');
      return new Promise<Record<string, string | null>>((resolve, reject) => { prepareWaiter = { files, resolve, reject }; });
    },
    async close() {
      await controller.dispose();
      await history.flush().catch(() => {});
      await rm(cwd, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    },
  };
}

function save(history: HistoryStore, id: string, controller: ChatController, state: ChatState): void {
  history.schedule({
    version: 1, id, sessionId: controller.sessionId(), updatedAt: new Date().toISOString(), controls,
    state: structuredClone(state),
  });
}

async function ask(controller: ChatController, prompt: string): Promise<void> {
  await controller.send(prompt);
  const turn = controller.snapshot().turns.at(-1);
  assert.equal(turn?.status, 'completed', `turn did not complete: ${JSON.stringify(turn)}`);
  assert.ok(turn?.backendTurnId, 'the backend turn ID must be available for safe rewind');
}

async function transcript(session: AgentSession | undefined): Promise<ChatMessage[]> {
  assert.ok(session?.loadTranscript, 'Codex App Server must expose the actual thread history');
  const messages: ChatMessage[] = [];
  await session.loadTranscript((message) => messages.push(message));
  return messages;
}

async function rewindCase(options: {
  label: string;
  turns: Array<{ prompt: string; file: string; text: string }>;
  target: number;
  editedPrompt: string;
  expectedBeforeReplay: Record<string, string | null>;
  expectedFiles: Record<string, string | null>;
  preexisting?: { file: string; text: string; extraFile: string; extraText: string };
}): Promise<void> {
  const f = await fixture(options.label);
  try {
    if (options.preexisting) {
      await writeFile(path.join(f.cwd, options.preexisting.file), options.preexisting.text);
      await writeFile(path.join(f.cwd, options.preexisting.extraFile), options.preexisting.extraText);
    }
    for (const turn of options.turns) await ask(f.controller, turn.prompt);

    const oldState = f.controller.snapshot();
    const target = oldState.turns[options.target];
    assert.ok(target, 'the selected turn exists');
    const oldSessionId = f.controller.sessionId();
    const oldSuffixIds = new Set(oldState.turns.slice(options.target).map((turn) => turn.backendTurnId));
    assert.ok(!oldSuffixIds.has(undefined));
    const oldTranscript = await transcript(f.controller.currentSession());
    const removedUserTexts = oldTranscript.filter((message) => message.role === 'user' && oldSuffixIds.has(message.backendTurnId)).map((message) => message.text);
    const removedAssistantBodies = oldTranscript.filter((message) => message.role === 'assistant' && message.final && oldSuffixIds.has(message.backendTurnId)).map((message) => message.text);
    const restoredBeforeReplay = f.captureBeforeReplay(Object.keys(options.expectedBeforeReplay).map((file) => path.join(f.cwd, file)));
    await f.controller.rewindAndSend(target.id, options.editedPrompt);
    const restoredFiles = await restoredBeforeReplay;
    assert.deepEqual(Object.fromEntries(Object.entries(restoredFiles).map(([file, content]) => [path.relative(f.cwd, file), content])), options.expectedBeforeReplay);
    assert.notEqual(f.controller.sessionId(), oldSessionId, 'Rewind must continue on a distinct real backend branch');
    const state = f.controller.snapshot();
    assert.equal(state.turns.at(-1)?.status, 'completed');
    assert.equal(state.messages.filter((message) => message.role === 'user').at(-1)?.text, options.editedPrompt);

    for (const [name, expected] of Object.entries(options.expectedFiles)) {
      if (expected === null) await assert.rejects(access(path.join(f.cwd, name)), { code: 'ENOENT' });
      else assert.equal(await readFile(path.join(f.cwd, name), 'utf8'), expected, `${name} after the edited turn`);
    }
    if (options.preexisting) assert.equal(await readFile(path.join(f.cwd, options.preexisting.extraFile), 'utf8'), options.preexisting.extraText);

    const branchTranscript = await transcript(f.controller.currentSession());
    const branchUsers = branchTranscript.filter((message) => message.role === 'user').map((message) => message.text);
    for (const userText of removedUserTexts) assert.ok(!branchUsers.includes(userText), `removed user turn leaked into branch transcript: ${userText}`);
    for (const body of removedAssistantBodies) {
      assert.ok(!branchTranscript.some((message) => message.role === 'assistant' && message.final && message.text === body), 'removed assistant body leaked into branch transcript');
    }

    const branchSessionId = f.controller.sessionId();
    assert.ok(branchSessionId, 'the branch session stays on the open controller');
    assert.equal(f.controller.snapshot().messages.filter((message) => message.role === 'user').at(-1)?.text, options.editedPrompt);
    console.log('LIVE_REWIND', JSON.stringify({
      scenario: options.label,
      model: 'gpt-6-luna',
      oldSessionId,
      branchSessionId: f.controller.sessionId(),
      removedUserTurns: removedUserTexts.length,
      removedAssistantBodies: removedAssistantBodies.length,
      restoredBeforeReplay: true,
      filesVerified: Object.keys(options.expectedFiles),
      historySessionIdSaved: false,
    }));
  } finally { await f.close(); }
}

test('Codex App Server live Prompt Rewind: final, middle, first, dirty workspace, and backend context', {
  skip: !enabled, timeout: 1_800_000,
}, async () => {
  await rewindCase({
    label: 'final',
    turns: [
      { prompt: 'Create a.txt with exact UTF-8 content A_T1_BASE, with no trailing newline and no other changes. After the write, reply exactly ACK_A_T1.', file: 'a.txt', text: 'A_T1_BASE' },
      { prompt: 'Replace a.txt with exact UTF-8 content A_T2_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_A_T2_OLD.', file: 'a.txt', text: 'A_T2_OLD' },
    ],
    target: 1,
    editedPrompt: 'Replace a.txt with exact UTF-8 content A_T2_EDITED, with no trailing newline and no other changes. After the write, reply exactly ACK_A_T2_EDITED.',
    expectedBeforeReplay: { 'a.txt': 'A_T1_BASE' },
    expectedFiles: { 'a.txt': 'A_T2_EDITED' },
  });

  await rewindCase({
    label: 'middle',
    turns: [
      { prompt: 'Create a.txt with exact UTF-8 content B_T1_BASE, with no trailing newline and no other changes. After the write, reply exactly ACK_B_T1.', file: 'a.txt', text: 'B_T1_BASE' },
      { prompt: 'Replace a.txt with exact UTF-8 content B_T2_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_B_T2_OLD.', file: 'a.txt', text: 'B_T2_OLD' },
      { prompt: 'Create b.txt with exact UTF-8 content B_T3_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_B_T3_OLD.', file: 'b.txt', text: 'B_T3_OLD' },
      { prompt: 'Replace a.txt with exact UTF-8 content B_T4_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_B_T4_OLD.', file: 'a.txt', text: 'B_T4_OLD' },
    ],
    target: 1,
    editedPrompt: 'Replace a.txt with exact UTF-8 content B_T2_EDITED, with no trailing newline and no other changes. After the write, reply exactly ACK_B_T2_EDITED.',
    expectedBeforeReplay: { 'a.txt': 'B_T1_BASE', 'b.txt': null },
    expectedFiles: { 'a.txt': 'B_T2_EDITED', 'b.txt': null },
  });

  await rewindCase({
    label: 'first',
    turns: [
      { prompt: 'Create a.txt with exact UTF-8 content C_T1_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_C_T1_OLD.', file: 'a.txt', text: 'C_T1_OLD' },
      { prompt: 'Replace a.txt with exact UTF-8 content C_T2_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_C_T2_OLD.', file: 'a.txt', text: 'C_T2_OLD' },
      { prompt: 'Create b.txt with exact UTF-8 content C_T3_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_C_T3_OLD.', file: 'b.txt', text: 'C_T3_OLD' },
    ],
    target: 0,
    editedPrompt: 'Create a.txt with exact UTF-8 content C_T1_EDITED, with no trailing newline and no other changes. After the write, reply exactly ACK_C_T1_EDITED.',
    expectedBeforeReplay: { 'a.txt': null, 'b.txt': null },
    expectedFiles: { 'a.txt': 'C_T1_EDITED', 'b.txt': null },
  });

  await rewindCase({
    label: 'dirty-workspace',
    turns: [
      { prompt: 'Replace a.txt with exact UTF-8 content D_AGENT_OLD, with no trailing newline and no other changes. After the write, reply exactly ACK_D_AGENT_OLD.', file: 'a.txt', text: 'D_AGENT_OLD' },
    ],
    target: 0,
    editedPrompt: 'Replace a.txt with exact UTF-8 content D_AGENT_EDITED, with no trailing newline and no other changes. After the write, reply exactly ACK_D_AGENT_EDITED.',
    expectedBeforeReplay: { 'a.txt': 'D_USER_UNCOMMITTED', 'user-extra.txt': 'D_USER_EXTRA' },
    expectedFiles: { 'a.txt': 'D_AGENT_EDITED', 'user-extra.txt': 'D_USER_EXTRA' },
    preexisting: { file: 'a.txt', text: 'D_USER_UNCOMMITTED', extraFile: 'user-extra.txt', extraText: 'D_USER_EXTRA' },
  });
});
