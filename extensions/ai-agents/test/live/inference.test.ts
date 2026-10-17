import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { createSession } from '../../src/providers/index.js';
import type { AgentSession, AgentUpdate, Selection } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';

const on = (name: string) => process.env[name] === '1';
const interactions = {
  requestPermission: async () => 'deny' as const,
  requestPlan: async () => 'rejected' as const,
  requestAnswers: async () => ({}),
};

function which(command: string): string {
  return execFileSync('which', ['-a', command], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0] ?? '';
}

async function temporary(): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-live-'));
  execFileSync('git', ['init', '-q'], { cwd });
  return { cwd, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

function joined(updates: AgentUpdate[]): string {
  // Thoughts and tool output must never satisfy an answer assertion.
  const answers = new Map<string, AgentUpdate>();
  for (const update of updates) if (update.role === 'assistant') answers.set(update.id, update);
  return [...answers.values()].map((update) => update.text).join('\n');
}

async function say(session: AgentSession, prompt: string): Promise<string> {
  const updates: AgentUpdate[] = [];
  await session.run(prompt, new AbortController().signal, (update) => updates.push(update));
  const text = joined(updates);
  assert.ok(updates.length > 0, 'the run produced no streamed updates');
  return text;
}

async function cancel(session: AgentSession): Promise<void> {
  const controller = new AbortController();
  const pending = session.run('Count from 1 to 40, one number per line. Do not use tools.', controller.signal, () => {});
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await pending;
    assert.fail('the turn finished before it could be cancelled');
  } catch (error) {
    assert.equal(error instanceof Error ? error.name : '', 'AbortError');
  } finally { clearTimeout(timer); }
}

async function exercise(options: SessionOptions): Promise<void> {
  const session = await createSession(options);
  try {
    assert.match(await say(session, 'Reply with exactly the word pong. Do not use tools.'), /pong/i);
    assert.match(await say(session, 'Reply with exactly the word pong2. Do not use tools.'), /pong2/i);
    assert.match(await say(session, 'Reply with exactly the word pong3. Do not use tools.'), /pong3/i);
    await cancel(session);
    const resumeId = session.sessionId;
    assert.ok(resumeId);
    await session.dispose();
    const restored = await createSession({ ...options, resumeId });
    try {
      assert.match(await say(restored, 'Reply with exactly the word resumed. Do not use tools.'), /resumed/i);
    } finally { await restored.dispose(); }
  } finally { await session.dispose(); }
}

test('Cursor SDK live inference', { skip: !on('AI_AGENTS_LIVE_CURSOR_TEST'), timeout: 240000 }, async () => {
  const { cwd, cleanup } = await temporary();
  try {
    await exercise({
      provider: 'cursor', backend: 'sdk', cwd, model: 'composer-2.5', storagePath: cwd, sandbox: 'enabled', interactions,
    });
    console.log('PASS cursor sdk text stream follow-up cancel resume');
  } finally { await cleanup(); }
});

test('Cursor ACP live inference', { skip: !on('AI_AGENTS_LIVE_ACP_TEST'), timeout: 240000 }, async () => {
  const agentPath = which('agent');
  assert.ok(agentPath);
  const { cwd, cleanup } = await temporary();
  try {
    await exercise({
      provider: 'cursor', backend: 'acp', cwd, model: 'composer-2.5', storagePath: cwd, agentPath, sandbox: 'enabled', interactions,
    });
    console.log('PASS cursor acp text stream follow-up cancel resume');
  } finally { await cleanup(); }
});

test('Cursor ACP: all three controller final answers match backend assistant text', { skip: !on('AI_AGENTS_LIVE_ACP_TEST'), timeout: 240000 }, async () => {
  const { cwd, cleanup } = await temporary();
  let observed: AgentUpdate[] = [];
  const selection: Selection = { provider: 'cursor', cwd, model: 'composer-2.5' };
  const controller = new ChatController(selection, async () => {
    const session = await createSession({ ...selection, backend: 'acp', storagePath: cwd, agentPath: which('agent'), sandbox: 'enabled', mode: 'ask', interactions });
    const run = session.run.bind(session);
    session.run = (prompt, signal, emit, ...rest) => run(prompt, signal, (update) => { observed.push(update); emit(update); }, ...rest);
    return session;
  }, () => {});
  controller.setModePreference('ask');
  try {
    for (const token of ['FIRST_REPLY', 'SECOND_REPLY', 'THIRD_REPLY']) {
      observed = [];
      await controller.send(`Reply with exactly ${token}. Do not use tools.`);
      const state = controller.snapshot();
      const turn = state.turns.at(-1)!;
      assert.equal(turn.status, 'completed');
      const answer = state.messages.find((message) => message.id === turn.finalMessageId);
      const backendFinal = observed.filter((update) => update.role === 'assistant' && update.final).at(-1);
      assert.ok(backendFinal, 'ACP must explicitly deliver final assistant text');
      assert.ok(backendFinal.text.trim());
      assert.equal(answer?.text, backendFinal.text);
      assert.match(answer.text, new RegExp(token));
    }
    assert.equal(controller.snapshot().turns.length, 3);
  } finally { await controller.dispose(); await cleanup(); }
});

test('Codex SDK live inference', { skip: !on('AI_AGENTS_LIVE_TEST'), timeout: 240000 }, async () => {
  const { cwd, cleanup } = await temporary();
  try {
    await exercise({
      provider: 'codex', backend: 'sdk', cwd, model: 'gpt-6-luna', storagePath: cwd, sandbox: 'read-only', approval: 'never',
      modelParams: [{ id: 'modelReasoningEffort', value: 'low' }], interactions,
    });
    console.log('PASS codex sdk text stream follow-up cancel resume effort');
  } finally { await cleanup(); }
});

test('Codex App Server live inference', { skip: !on('AI_AGENTS_LIVE_APP_SERVER_TEST'), timeout: 240000 }, async () => {
  const { cwd, cleanup } = await temporary();
  try {
    await exercise({
      provider: 'codex', backend: 'app-server', cwd, model: 'gpt-6-luna', storagePath: cwd, sandbox: 'read-only', approval: 'never',
      modelParams: [{ id: 'modelReasoningEffort', value: 'low' }], interactions,
    });
    console.log('PASS codex app-server text stream follow-up cancel resume effort');
  } finally { await cleanup(); }
});

test('provider switch keeps each live backend on its own session', { skip: !on('AI_AGENTS_LIVE_TEST') || !on('AI_AGENTS_LIVE_CURSOR_TEST'), timeout: 240000 }, async () => {
  const { cwd, cleanup } = await temporary();
  const controls = {
    codex: { mode: 'agent' as const, sandbox: 'read-only', approval: 'never', backend: 'sdk' as const, network: false, webSearch: '', additionalDirectories: [] as string[] },
    cursor: { mode: 'agent' as const, sandbox: 'enabled', approval: 'never', backend: 'sdk' as const, network: false, webSearch: '', additionalDirectories: [] as string[] },
  };
  try {
    const controller = new ChatController({ provider: 'codex', cwd, model: 'gpt-6-luna' }, async (selection: Selection) => createSession({
      ...selection, ...controls[selection.provider], storagePath: cwd, interactions,
    }), () => {});
    await controller.send('Reply with exactly the word pong. Do not use tools.');
    assert.match(controller.snapshot().messages.map((message) => message.text).join('\n'), /pong/i);
    await controller.select({ provider: 'cursor', cwd, model: 'composer-2.5' });
    assert.equal(controller.snapshot().messages.length, 0);
    await controller.send('Reply with exactly the word pong. Do not use tools.');
    assert.match(controller.snapshot().messages.map((message) => message.text).join('\n'), /pong/i);
    assert.equal(controller.snapshot().selection.provider, 'cursor');
    await controller.dispose();
    console.log('PASS provider switch codex-sdk to cursor-sdk');
  } finally { await cleanup(); }
});
