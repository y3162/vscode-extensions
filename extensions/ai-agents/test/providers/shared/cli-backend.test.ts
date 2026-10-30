import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { HistoryStore, type SavedConversation } from '../../../src/history-store.js';
import { capabilitiesFor, defaultControls } from '../../../src/capabilities.js';
import { createSession } from '../../../src/providers/index.js';
import { cursorCliArgs, cursorCliModelArg, listCursorCliModels, parseCursorCliModels, createCursorCliSession } from '../../../src/providers/cursor-cli.js';
import { codexCliArgs, createCodexCliSession } from '../../../src/providers/codex-cli.js';
import { readCliText, readJsonEvents, spawnCli, type CliExit, type CliRun, type CliRunRequest, type CliSpawn } from '../../../src/providers/cli-jsonl.js';
import { listModels } from '../../../src/providers/models.js';
import { emptyPlanState, type AgentUpdate, type ChatState, type SessionSummary } from '../../../src/types.js';
import { buildShell } from '../../../src/view-state.js';
import { AgentsSidebar } from '../../../src/sidebar.js';
import { commands, resetVscode, window, workspace } from '../../support/vscode-stub.js';
import { prepareHarnessRoot } from '../../support/vscode-harness.js';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function scripted(lines: string[], options: { pause?: boolean; code?: number; stderr?: string } = {}): { spawn: CliSpawn; requests: CliRunRequest[]; killed: () => boolean } {
  const requests: CliRunRequest[] = [];
  let killed = false;
  const spawn: CliSpawn = (request) => {
    requests.push(request);
    let stop = false;
    let releaseWait = () => {};
    let finish: (value: CliExit) => void = () => {};
    const result = new Promise<CliExit>((resolve) => { finish = resolve; });
    const settle = (value: CliExit) => finish(value);
    const run: CliRun = {
      lines: (async function* () {
        for (const line of lines) {
          if (stop) return;
          yield line;
        }
        if (options.pause) await new Promise<void>((resolve) => { releaseWait = resolve; });
      })(),
      kill() {
        if (stop) return;
        stop = true;
        killed = true;
        releaseWait();
        settle({ code: null, signal: 'SIGTERM', stderr: '' });
      },
      result: () => result,
    };
    queueMicrotask(() => {
      if (!options.pause) settle({ code: options.code ?? 0, signal: null, stderr: options.stderr ?? '' });
    });
    return run;
  };
  return { spawn, requests, killed: () => killed };
}

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Cursor CLI concatenates deltas, ignores the final snapshot, and keeps resume, model, and sandbox arguments', async (t) => {
  const cwd = await directory(t);
  const first = scripted([
    json({ type: 'system', subtype: 'init', session_id: 'chat-1' }),
    json({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] }, session_id: 'chat-1' }),
    json({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'lo' }] }, session_id: 'chat-1' }),
    json({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, session_id: 'chat-1' }),
    json({
      type: 'tool_call', subtype: 'completed', call_id: 'call-1', session_id: 'chat-1', env: 'SECRET=value',
      tool_call: { shellToolCall: { args: { command: 'pwd' }, result: { stdout: 'ok' } } },
    }),
    json({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '!' }] }, session_id: 'chat-1' }),
    json({ type: 'result', subtype: 'success', is_error: false, result: 'Hello!', session_id: 'chat-1' }),
    'not json',
  ]);
  const identities: SessionSummary[] = [];
  const session = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'true' }],
    storagePath: cwd, apiKey: 'cursor-secret', sandbox: 'disabled', additionalDirectories: ['/extra'], mode: 'plan',
    onIdentity: (identity) => identities.push(identity),
  }, first.spawn);
  const updates: AgentUpdate[] = [];
  await session.run('plan this', new AbortController().signal, (update) => updates.push(update), undefined, {
    intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd, model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'true' }] },
  });
  const args = first.requests[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 5), ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust']);
  assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'disabled');
  assert.equal(args[args.indexOf('--mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5[fast=true]');
  assert.equal(args[args.indexOf('--add-dir') + 1], '/extra');
  assert.equal(args.at(-1), 'plan this');
  assert.equal(args.includes('--force') || args.includes('--yolo'), false);
  assert.equal(JSON.stringify(args).includes('cursor-secret'), false);
  assert.equal(first.requests[0]?.env?.CURSOR_API_KEY, 'cursor-secret');
  assert.equal(session.sessionId, 'chat-1');
  assert.equal(identities[0]?.titleSource, 'local');
  const assistant = updates.filter((update) => update.role === 'assistant');
  const latest = new Map<string, string>();
  for (const update of assistant) latest.set(update.id, update.text);
  assert.deepEqual([...latest.values()], ['Hello', '!']);
  assert.equal(assistant.filter((update) => update.id === assistant[0]?.id).length, 3);
  assert.equal(updates.some((update) => update.text.includes('SECRET')), false);
  assert.equal(updates.find((update) => update.id === 'call-1')?.tool?.target, 'pwd');
  assert.equal(updates.filter((update) => update.meta?.type === 'plan').length, 1);
  assert.equal(updates.find((update) => update.meta?.type === 'plan')?.meta?.plan?.source, 'assistant-text');
  assert.equal(typeof session.setModel, 'function');
  await session.setModel!({ provider: 'cursor', cwd, model: 'auto' });
  await session.run('follow up', new AbortController().signal, () => undefined);
  const resumedArgs = first.requests[1]?.args ?? [];
  assert.equal(resumedArgs[resumedArgs.indexOf('--resume') + 1], 'chat-1');
  assert.equal(resumedArgs[resumedArgs.indexOf('--model') + 1], 'auto');
  assert.equal(resumedArgs.at(-1), 'follow up');

  // A turn-level selection without parameters must not inherit a previous model's overrides.
  await session.setModel!({ provider: 'cursor', cwd, model: 'old', modelParams: [{ id: 'fast', value: 'true' }] });
  await session.run('composer', new AbortController().signal, () => undefined, undefined, {
    intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: 'composer-2.5' },
  });
  const selectedArgs = first.requests[2]!.args;
  assert.equal(selectedArgs[selectedArgs.indexOf('--model') + 1], 'composer-2.5');

  const second = scripted([json({ type: 'result', subtype: 'success', is_error: false, result: 'again', session_id: 'chat-1' })]);
  const resumed = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'chat-1', sandbox: 'enabled',
  }, second.spawn);
  await resumed.run('next', new AbortController().signal, () => undefined);
  assert.equal(second.requests[0]?.args.includes('--resume'), true);
  assert.equal(second.requests[0]?.args[second.requests[0]!.args.indexOf('--resume') + 1], 'chat-1');
  assert.equal(second.requests[0]?.args.includes('--model'), false);
  assert.equal(second.requests[0]?.args.includes('--mode'), false);
});

test('Cursor CLI records a createPlan tool without appending the assistant fallback, and abort kills the process', async () => {
  const planned = scripted([
    json({ type: 'system', subtype: 'init', session_id: 'chat-plan' }),
    json({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }),
    json({
      type: 'tool_call', subtype: 'completed', call_id: 'plan-1',
      tool_call: { createPlanToolCall: { args: { plan: '# Plan' } } },
    }),
  ]);
  const session = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd: '/work', model: 'composer-2.5', storagePath: '/work', mode: 'plan',
  }, planned.spawn);
  const updates: AgentUpdate[] = [];
  await session.run('plan', new AbortController().signal, (update) => updates.push(update), undefined, {
    intent: 'plan', mode: 'plan', selection: { provider: 'cursor', cwd: '/work', model: 'composer-2.5' },
  });
  assert.deepEqual(updates.filter((update) => update.meta?.type === 'plan').map((update) => update.id), ['plan-1']);

  const hanging = scripted([json({ type: 'system', subtype: 'init', session_id: 'chat-stop' })], { pause: true });
  const stopping = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd: '/work', model: '', storagePath: '/work',
  }, hanging.spawn);
  const controller = new AbortController();
  const pending = stopping.run('stop me', controller.signal, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(hanging.killed(), true);
  await stopping.dispose();
});

test('Cursor CLI rejects images before launch and reads model ids from colored list output', async () => {
  const fake = scripted([]);
  const session = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd: '/work', model: 'composer-2.5', storagePath: '/work',
  }, fake.spawn);
  await assert.rejects(session.run('see', new AbortController().signal, () => undefined, {
    images: [{ mimeType: 'image/png', data: 'aaaa' }],
  }), /画像添付/);
  assert.equal(fake.requests.length, 0);
  const models = parseCursorCliModels([
    '\u001b[2mAvailable models\u001b[22m',
    '',
    '\u001b[36mcomposer-2.5\u001b[39m \u001b[2m- Composer 2.5\u001b[22m \u001b[2m(default)\u001b[22m',
    'auto - Auto (current, default)',
    'Tip: use --model <id>',
  ].join('\n'));
  assert.deepEqual(models.map((model) => [model.id, model.label, model.isDefault]), [
    ['composer-2.5', 'Composer 2.5', true],
    ['auto', 'Auto', true],
  ]);
  const listed = scripted(['composer-2.5 - Composer 2.5 (default)']);
  const fromCli = await listCursorCliModels({ agentPath: 'agent', cwd: '/work' }, listed.spawn);
  assert.deepEqual(listed.requests[0]?.args, ['--list-models']);
  assert.equal(fromCli[0]?.id, 'composer-2.5');
  assert.deepEqual(parseCursorCliModels('auto - Auto (default)\ncomposer-2.5 - Composer 2.5\ncomposer-2.5-fast - Composer 2.5 Fast\n').map(m => m.id), ['auto', 'composer-2.5', 'composer-2.5-fast']);
  assert.equal(parseCursorCliModels('auto - Auto (default)').some(m => m.id === 'composer-2.5'), false);
  const empty = scripted(['Tip: nothing here']);
  await assert.rejects(listCursorCliModels({ agentPath: 'agent' }, empty.spawn), /空/);
});

test('Cursor CLI surfaces model rejection without switching models', async () => {
  const fake = scripted([], { code: 1, stderr: 'Cannot use this model: composer-2.5. Available models: auto' });
  const session = await createCursorCliSession({ provider: 'cursor', backend: 'cli', cwd: '/work', model: 'composer-2.5', storagePath: '/work' }, fake.spawn);
  await assert.rejects(session.run('hello', new AbortController().signal, () => undefined), /Cannot use this model: composer-2\.5/);
  const args = fake.requests[0]!.args;
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5');
  assert.equal(fake.requests.length, 1);
});

test('Codex CLI maps thread events, refuses interactive approval, and passes exec arguments', async (t) => {
  const cwd = await directory(t);
  const fake = scripted([
    json({ type: 'thread.started', thread_id: 'thread-9' }),
    json({ type: 'item.completed', item: { id: 'assistant', type: 'agent_message', text: 'Hello' } }),
    json({ type: 'item.completed', item: { id: 'bad', type: 'agent_message' } }),
    json({ type: 'item.completed', item: { id: 'mystery', type: 'not-a-thread-item', text: 'guess' } }),
    json({ type: 'item.completed', item: { id: 'file', type: 'file_change', status: 'completed', changes: [{ path: 'note.txt', kind: 'update' }] } }),
    json({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }),
  ]);
  const identities: SessionSummary[] = [];
  const session = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: 'gpt-test', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }],
    storagePath: cwd, apiKey: 'codex-secret', sandbox: 'read-only', approval: 'never', network: true, webSearch: 'cached',
    additionalDirectories: ['/extra'], onIdentity: (identity) => identities.push(identity),
  }, {
    spawn: fake.spawn,
    writeImages: async () => ['/tmp/picture.png'],
  });
  const updates: AgentUpdate[] = [];
  await session.run('prompt', new AbortController().signal, (update) => updates.push(update), {
    images: [{ mimeType: 'image/png', data: 'aaaa' }],
  }, {
    intent: 'chat', mode: 'agent', selection: { provider: 'codex', cwd, model: 'gpt-test', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] },
  });
  const args = fake.requests[0]?.args ?? [];
  assert.ok(args.includes('exec') && args.includes('--json') && args.includes('--skip-git-repo-check'));
  assert.equal(args.includes('-a'), false);
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.equal(args[args.indexOf('-C') + 1], cwd);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-test');
  assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="low"');
  assert.ok(args.includes('web_search="cached"'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/picture.png');
  assert.equal(args.includes('--force') || args.includes('--yolo'), false);
  assert.equal(JSON.stringify(args).includes('codex-secret'), false);
  assert.equal(fake.requests[0]?.env?.CODEX_API_KEY, 'codex-secret');
  assert.equal(fake.requests[0]?.input, 'prompt');
  assert.equal(session.sessionId, 'thread-9');
  assert.equal(identities[0]?.title, 'prompt');
  assert.equal(updates.find((update) => update.id === 'assistant')?.text, 'Hello');
  assert.equal(updates.some((update) => update.text === 'guess'), false);
  assert.equal(updates.find((update) => update.id === 'file')?.meta?.files?.[0]?.path, 'note.txt');
  assert.equal(updates.find((update) => update.meta?.type === 'usage')?.meta?.usage?.source, 'codex-cli');
  assert.equal(updates.find((update) => update.meta?.type === 'usage')?.meta?.usage?.cacheWriteInputTokens, 0);

  const refused = scripted([]);
  await assert.rejects(createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'on-request',
  }, { spawn: refused.spawn }), /対話承認/);
  assert.equal(refused.requests.length, 0);

  const failed = scripted([json({ type: 'turn.failed', error: { message: 'backend failed' } })]);
  const failing = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never', resumeId: 'thread-9',
  }, { spawn: failed.spawn });
  await assert.rejects(failing.run('again', new AbortController().signal, () => undefined), /backend failed/);
  assert.equal(failed.requests[0]?.args.at(-2), 'resume');
  assert.equal(failed.requests[0]?.args.at(-1), 'thread-9');
});

test('Codex CLI verifies the completed turn and offers a checked rewind branch', async (t) => {
  const cwd = await directory(t);
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(path.join(cwd, 'note.txt'), 'before\n');
  execFileSync('git', ['add', 'note.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd });
  const fake = scripted([
    json({ type: 'thread.started', thread_id: 'thread-1' }),
    json({ type: 'item.completed', item: { id: 'file', type: 'file_change', status: 'completed', changes: [{ path: 'note.txt', kind: 'update' }] } }),
    json({ type: 'turn.completed' }),
  ]);
  const history = {
    turns: async () => [{ id: 'turn-1', prompt: 'change note' }],
    forkBeforeTurn: async (_threadId: string, turnId: string) => {
      assert.equal(turnId, 'turn-1');
      return 'branch-1';
    },
    terminals: async () => [],
  };
  const session = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd }, {
    spawn: (request) => { writeFileSync(path.join(cwd, 'note.txt'), 'after\n'); return fake.spawn(request); }, history,
  });
  const updates: AgentUpdate[] = [];
  await session.run('change note', new AbortController().signal, (update) => updates.push(update));
  assert.equal(session.latestBackendTurnId?.(), 'turn-1');
  assert.equal(session.rewindUnsupportedReason?.(), undefined);
  await session.verifyTurnHistory?.(['turn-1']);
  assert.equal(await session.forkBeforeTurn?.('turn-1'), 'branch-1');
  assert.deepEqual(await session.listBackgroundTerminals?.(), []);
  const files = updates.find((update) => update.id === 'workspace-changes:turn-1')?.meta?.files;
  assert.equal(files?.[0]?.previousText, 'before\n');
  assert.equal(files?.[0]?.previousMode, 0o644);

  const stale = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: fake.spawn,
    history: { ...history, turns: async () => [{ id: 'turn-1' }, { id: 'external-turn' }] },
  });
  await assert.rejects(stale.verifyTurnHistory!(['turn-1']), /一致しません/);
  await assert.rejects(stale.forkBeforeTurn!('turn-1'), /検証されていません/);
});

test('Codex CLI disables rewind when history inspection fails or cannot match a completed run', async (t) => {
  const cwd = await directory(t);
  const events = [json({ type: 'thread.started', thread_id: 'thread-1' }), json({ type: 'turn.completed' })];
  const never = async () => [];
  const empty = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd }, {
    spawn: scripted(events).spawn,
    history: { turns: never, forkBeforeTurn: async () => 'branch', terminals: async () => [] },
  });
  await assert.rejects(empty.verifyTurnHistory!([]), /照合できる/);
  await assert.rejects(empty.forkBeforeTurn!('turn-1'), /会話ID/);
  await assert.rejects(empty.listBackgroundTerminals!(), /会話ID/);
  await empty.run('prompt', new AbortController().signal, () => undefined);
  assert.match(empty.rewindUnsupportedReason?.() ?? '', /一意に対応付けられません/);
  assert.equal(empty.latestBackendTurnId?.(), undefined);

  const failedResume = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: scripted(events).spawn,
    history: { turns: async () => { throw new Error('history unavailable'); }, forkBeforeTurn: async () => 'branch', terminals: async () => [] },
  });
  assert.match(failedResume.rewindUnsupportedReason?.() ?? '', /history unavailable/);
  await assert.rejects(failedResume.forkBeforeTurn!('turn-1'), /history unavailable/);
  await failedResume.run('prompt', new AbortController().signal, () => undefined);
  assert.match(failedResume.rewindUnsupportedReason?.() ?? '', /history unavailable/);

  const stringResume = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: scripted(events).spawn,
    history: { turns: async () => { throw 'initial string failure'; }, forkBeforeTurn: async () => 'branch', terminals: async () => [] },
  });
  assert.equal(stringResume.rewindUnsupportedReason?.(), 'initial string failure');

  let beforeRunCalls = 0;
  const stringBeforeRun = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: scripted(events).spawn,
    history: {
      turns: async () => { beforeRunCalls += 1; if (beforeRunCalls === 2) throw 'before-run string failure'; return []; },
      forkBeforeTurn: async () => 'branch', terminals: async () => [],
    },
  });
  await stringBeforeRun.run('prompt', new AbortController().signal, () => undefined);
  assert.equal(stringBeforeRun.rewindUnsupportedReason?.(), 'before-run string failure');

  let calls = 0;
  const nonErrorFailure = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: scripted(events).spawn,
    history: {
      turns: async () => { calls += 1; if (calls === 3) throw 'history string failure'; return []; },
      forkBeforeTurn: async () => 'branch', terminals: async () => [],
    },
  });
  await nonErrorFailure.run('prompt', new AbortController().signal, () => undefined);
  assert.equal(nonErrorFailure.rewindUnsupportedReason?.(), 'history string failure');

  let mismatchedCalls = 0;
  const unavailable = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, resumeId: 'thread-1' }, {
    spawn: scripted(events).spawn,
    history: { turns: async () => { mismatchedCalls += 1; return mismatchedCalls === 3 ? [{ id: 'turn-1', prompt: 'different' }] : []; }, forkBeforeTurn: async () => 'branch', terminals: async () => [] },
  });
  await unavailable.run('prompt', new AbortController().signal, () => undefined);
  assert.match(unavailable.rewindUnsupportedReason?.() ?? '', /一意に対応付けられません/);
});

test('createSession routes both providers to CLI and rejects removed SDK sessions', async (t) => {
  const cwd = await directory(t);
  const cursor = scripted([json({ type: 'result', result: 'ok', session_id: 'routed' })]);
  const cursorSession = await createSession({ provider: 'cursor', cwd, model: '', storagePath: cwd }, { cliSpawn: cursor.spawn });
  await cursorSession.run('hi', new AbortController().signal, () => undefined);
  assert.equal(cursor.requests.length, 1);
  const codex = scripted([json({ type: 'thread.started', thread_id: 'routed-codex' })]);
  const codexSession = await createSession({ provider: 'codex', cwd, model: '', storagePath: cwd }, { cliSpawn: codex.spawn });
  await codexSession.run('hi', new AbortController().signal, () => undefined);
  assert.ok(codex.requests[0]?.args.includes('exec'));
  await assert.rejects(createSession({ provider: 'codex', backend: 'sdk', cwd, model: '', storagePath: cwd }), /no longer supported/);
});

test('history accepts a CLI backend and Cursor CLI login opens the agent command', async (t) => {
  const root = await directory(t);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const record: SavedConversation = {
    version: 1, id, sessionId: 'cli-session', updatedAt: '2026-10-20T00:00:00.000Z',
    controls: defaultControls('cursor', 'cli'),
    state: {
      selection: { provider: 'cursor', cwd: '/work', model: 'composer-2.5' },
      busy: false, messages: [{ id: 'user', role: 'user', text: 'saved cli' }], queue: [], status: 'idle', usage: null,
      changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
      plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
    },
  };
  await writeFile(path.join(root, `${id}.json`), JSON.stringify(record));
  const store = new HistoryStore(root);
  await store.load();
  assert.equal(store.errors.length, 0);
  assert.equal(store.get(id)?.controls.backend, 'cli');
  const rejected = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await writeFile(path.join(root, `${rejected}.json`), JSON.stringify({ ...record, id: rejected, controls: { ...record.controls, backend: 'other' } }));
  const invalid = new HistoryStore(root);
  await invalid.load();
  assert.equal(invalid.errors.length, 1);
  assert.equal(invalid.get(rejected), undefined);

  resetVscode();
  const paths = prepareHarnessRoot();
  workspace.configuration['ai-agents'] = { ...workspace.configuration['ai-agents'], 'cursor.agentPath': '/opt/My Agent/agent' };
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never);
  t.after(() => sidebar.dispose());
  await sidebar.handleMessage({ type: 'select', provider: 'cursor', cwd: paths.workspacePath });
  await sidebar.handleMessage({ type: 'configure', backend: 'cli' });
  await sidebar.signIn();
  assert.equal(commands.executed.some((entry) => entry.command === 'ai-agents.cursorLogin'), false);
  assert.equal(window.terminals.at(-1)?.sent[0], "'/opt/My Agent/agent' login");
});

test('settings report CLI without offering backend choices', () => {
  const chat = (provider: 'cursor' | 'codex'): ChatState => ({
    selection: { provider, cwd: '/work', model: '' },
    busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
  });
  const shell = (provider: 'cursor' | 'codex') => buildShell({
    state: chat(provider), folders: [{ name: 'work', path: '/work' }], modelLabel: 'Model', hasModelDetails: false,
    capabilities: capabilitiesFor(provider, 'cli'), controls: defaultControls(provider, 'cli'), locale: 'en',
    tokens: { permission: null, plan: null, question: null }, backends: { cursor: 'cli', codex: 'cli' },
  });
  assert.equal('backendChoices' in shell('cursor'), false);
  assert.equal(shell('cursor').backendLabel, 'CLI');
  assert.equal('backendChoices' in shell('codex'), false);
  assert.equal(shell('codex').backendLabel, 'CLI');
});

function fakeLaunch(behavior: { streams?: boolean; killThrows?: boolean; hang?: boolean; emitError?: boolean; stderr?: string } = {}): typeof spawn {
  return (() => {
    const events = new EventEmitter();
    const stdin = behavior.streams === false ? null : Object.assign(new EventEmitter(), {
      write() { return true; },
      end() { return this; },
    });
    const stderr = behavior.streams === false ? null : Object.assign(new EventEmitter(), {
      setEncoding() { return this; },
    });
    const child = Object.assign(events, {
      stdin, stdout: null, stderr, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill() {
        if (behavior.killThrows) throw new Error('kill failed');
        this.exitCode = 0;
        this.signalCode = null;
        events.emit('close', 0, null);
        return true;
      },
    });
    queueMicrotask(() => {
      if (stderr && behavior.stderr) stderr.emit('data', behavior.stderr);
      if (stdin) stdin.emit('error', new Error('EPIPE'));
      if (behavior.emitError) events.emit('error', new Error('spawn failed'));
      if (!behavior.hang && !behavior.killThrows) {
        child.exitCode = behavior.emitError ? null : 0;
        child.signalCode = null;
        events.emit('close', child.exitCode, child.signalCode);
      }
    });
    return child;
  }) as unknown as typeof spawn;
}

test('spawnCli launches node, skips malformed JSON, and reports process failures', async (t) => {
  const cwd = await directory(t);
  const success = path.join(cwd, 'success.js');
  await writeFile(success, `process.stdin.on('data', () => undefined);
process.stdin.on('end', () => {
  process.stderr.write('s'.repeat(4500));
  process.stdout.write('alpha\\n\\n  \\nbeta\\n');
  process.exit(0);
});
`);
  const streamed = spawnCli({
    command: success, args: [], cwd, input: 'hello', env: { ...process.env, AI_AGENTS_CLI_MARKER: 'yes' },
  });
  const lines: string[] = [];
  for await (const line of streamed.lines) lines.push(line);
  const finished = await streamed.result();
  streamed.kill();
  assert.deepEqual(lines, ['alpha', '', '  ', 'beta']);
  assert.equal(finished.code, 0);
  assert.equal(finished.stderr.length, 4000);

  const failing = path.join(cwd, 'fail.js');
  await writeFile(failing, 'process.exit(4);\n');
  await assert.rejects(readCliText(spawnCli({ command: failing, args: [], cwd }), new AbortController().signal), /exited \(4\)/);
  const longError = spawnCli({ command: process.execPath, args: ['-e', "process.stderr.write('Cannot use this model: composer-2.5[bad=x]. Available models: ' + 'x'.repeat(10000)); process.exitCode = 1"], cwd });
  await assert.rejects(readCliText(longError, new AbortController().signal), /Cannot use this model: composer-2\.5\[bad=x\]/);
  await assert.rejects(readCliText(spawnCli({ command: path.join(cwd, 'missing-bin'), args: [], cwd }), new AbortController().signal), /ENOENT/);

  const sleeping = spawnCli({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd });
  const killed = readCliText(sleeping, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  sleeping.kill();
  await assert.rejects(killed, /SIGTERM/);

  const events: unknown[] = [];
  await readJsonEvents(scripted(['', '  ', 'not json', json({ type: 'ok' }), 'null']).spawn({ command: 'x', args: [] }), new AbortController().signal, (event) => {
    events.push(event);
  });
  assert.deepEqual(events, [{ type: 'ok' }, null]);
  await assert.rejects(readJsonEvents(scripted(['{}'], { code: 3, stderr: 'boom' }).spawn({ command: 'x', args: [] }), new AbortController().signal, () => undefined), /boom/);
  await assert.rejects(readCliText(scripted(['x'], { code: 3 }).spawn({ command: 'x', args: [] }), new AbortController().signal), /exited \(3\)/);
  await assert.rejects(readJsonEvents(scripted(['pending'], { pause: true }).spawn({ command: 'x', args: [] }), AbortSignal.abort(new Error('stopped')), () => undefined), /stopped/);
  await assert.rejects(readCliText(scripted(['pending']).spawn({ command: 'x', args: [] }), AbortSignal.abort('stop')), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');

  const broken = spawnCli({ command: 'x', args: [], input: 'text' }, fakeLaunch({ streams: true, emitError: true, stderr: 'spawn broke' }));
  await assert.rejects(readCliText(broken, new AbortController().signal), /spawn broke/);
  broken.kill();
  const hanging = spawnCli({ command: 'x', args: [] }, fakeLaunch({ streams: false, hang: true }));
  const completed = readJsonEvents(hanging, new AbortController().signal, () => undefined);
  hanging.kill();
  await completed;
  const stubborn = spawnCli({ command: 'x', args: [], input: 'text' }, fakeLaunch({ streams: false, killThrows: true }));
  stubborn.kill();

  const controller = new AbortController();
  let delivered = 0;
  const continuing: CliRun = {
    lines: (async function* () {
      yield json({ ok: 1 });
      yield json({ ok: 2 });
    })(),
    kill() {},
    result: async () => ({ code: 0, signal: null, stderr: '' }),
  };
  await assert.rejects(readJsonEvents(continuing, controller.signal, () => {
    delivered += 1;
    controller.abort();
  }), (error: Error) => error.name === 'AbortError');
  assert.equal(delivered, 1);
});

test('Cursor CLI model text and tool events cover partial, nested, and failed results', async (t) => {
  assert.equal(cursorCliModelArg('  ', [{ id: 'fast', value: 'true' }]), undefined);
  assert.equal(cursorCliModelArg('composer', [{ id: '', value: 'true' }, { id: 'fast', value: '' }, { id: 'fast', value: 'true' }]), 'composer[fast=true]');
  assert.equal(cursorCliArgs({ prompt: 'hello' }).includes('--model'), false);
  assert.equal(cursorCliArgs({ prompt: 'hello', mode: 'ask', sandbox: 'disabled' }).includes('--mode'), true);
  assert.deepEqual(parseCursorCliModels([
    'composer-2.5',
    'composer-2.5 - Composer 2.5',
    'gpt - GPT (current)',
    'auto - Auto (default)',
    'auto - Auto again (default)',
  ].join('\n')).map((model) => [model.id, model.label, model.isDefault ?? false]), [
    ['composer-2.5', 'composer-2.5', false],
    ['gpt', 'GPT', false],
    ['auto', 'Auto', true],
  ]);

  const cwd = await directory(t);
  const listed = scripted(['composer-2.5 - Composer 2.5 (default)']);
  await listCursorCliModels({ agentPath: 'agent', cwd, apiKey: 'cursor-key' }, listed.spawn);
  assert.equal(listed.requests[0]?.env?.CURSOR_API_KEY, 'cursor-key');
  const agent = path.join(cwd, 'agent.js');
  await writeFile(agent, `require('node:fs').writeFileSync(process.argv[1] + '.key', process.env.CURSOR_API_KEY || '');
process.stdout.write('composer-2.5 - Composer 2.5\\n');
`);
  const models = await listModels({ provider: 'cursor', backend: 'cli', cwd, agentPath: agent, apiKey: 'cursor-key' });
  assert.equal(models[0]?.id, 'composer-2.5');
  assert.equal(await readFile(`${agent}.key`, 'utf8'), 'cursor-key');

  const tools = scripted([
    '',
    'not json',
    'null',
    json({ type: 'assistant', message: {} }),
    json({ type: 'assistant', message: { content: [] } }),
    json({ type: 'assistant', message: { content: [{ type: 'image' }, { type: 'text', text: 3 }, { type: 'text', text: 'Hi' }] } }),
    json({ type: 'tool_call', subtype: 'completed', tool_call: null }),
    json({ type: 'tool_call', subtype: 'completed', tool_call: { partialToolCall: { args: {} } } }),
    json({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: {} } } }),
    json({ type: 'tool_call', subtype: 'completed', tool_call: { ToolCall: { args: { command: 'true' }, result: { stdout: 'ran' } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: '', tool_call: { shellToolCall: null } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'shell-args', tool_call: { shellToolCall: { args: null, result: { stdout: 'direct' } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'shell-success', tool_call: { shellToolCall: { args: { command: 'echo' }, result: { success: { stdout: 'ok' } } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'shell-text', tool_call: { shellToolCall: { args: { command: 'echo' }, result: 'text' } } }),
    json({
      type: 'tool_call', subtype: 'completed', call_id: 'grep',
      tool_call: { tool: { case: 'grep', value: { args: { pattern: 'todo' }, result: { result: { case: 'success', value: { stdout: 'hit' } } } } } },
    }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'nested-empty', tool_call: { tool: { case: 'shell', value: null } } }),
    json({
      type: 'tool_call', subtype: 'completed', call_id: 'nested-miss',
      tool_call: { tool: { case: 1 }, shellToolCall: { args: { command: 'fallback' }, result: { result: { case: 'failure' }, stdout: 'root' } } },
    }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'empty-plan', tool_call: { createPlanToolCall: { args: { plan: '   ' } } } }),
    json({
      type: 'tool_call', subtype: 'completed', call_id: 'todos',
      tool_call: { updateTodosToolCall: { args: { todos: [
        { content: 'write', status: 'in_progress' }, { text: 'check', completed: true }, { content: 'wait', completed: false }, { content: '' }, null, 'skip',
      ] } } },
    }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'empty-todos', tool_call: { updateTodosToolCall: { args: { todos: 'nope' } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'edit', tool_call: { editToolCall: { args: { path: 'a.ts', diff: '+new' } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'write', tool_call: { writeToolCall: { args: { path: 'out.txt' }, result: null } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'delete', tool_call: { deleteToolCall: { args: { path: 'old.txt' }, result: { diff: '-old' } } } }),
    json({ type: 'tool_call', subtype: 'completed', call_id: 'edit-miss', tool_call: { editToolCall: { args: { diff: '+x' }, result: 'not-an-object' } } }),
    json({ type: 'result', is_error: false, result: 'snapshot' }),
  ]);
  const session = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: 'composer', storagePath: cwd,
  }, tools.spawn);
  await session.setMode!('ask');
  const updates: AgentUpdate[] = [];
  await session.run('inspect', new AbortController().signal, (update) => updates.push(update));
  assert.equal(tools.requests[0]?.args[tools.requests[0]!.args.indexOf('--mode') + 1], 'ask');
  assert.equal(updates.find((update) => update.role === 'assistant')?.text, 'Hi');
  assert.equal(updates.find((update) => update.id === 'tool-read')?.text.startsWith('running'), true);
  assert.equal(updates.find((update) => update.id === 'tool-ToolCall')?.tool?.name, 'ToolCall');
  assert.equal(updates.find((update) => update.id === 'grep')?.text.includes('hit'), true);
  assert.equal(updates.find((update) => update.id === 'shell-success')?.text.includes('ok'), true);
  assert.equal(updates.find((update) => update.id === 'nested-miss')?.text.includes('root'), true);
  assert.equal(updates.find((update) => update.id === 'empty-plan')?.role, 'tool');
  assert.equal(updates.find((update) => update.id === 'todos')?.meta?.type, 'todo');
  assert.deepEqual(updates.find((update) => update.id === 'todos')?.meta?.todos, [
    { content: 'write', status: 'in_progress' }, { content: 'check', status: 'completed' }, { content: 'wait', status: 'pending' },
  ]);
  assert.equal(updates.find((update) => update.id === 'edit')?.meta?.files?.[0]?.diff, '+new');
  assert.equal(updates.find((update) => update.id === 'write')?.meta?.files?.[0]?.kind, 'add');
  assert.equal(updates.find((update) => update.id === 'delete')?.meta?.files?.[0]?.kind, 'delete');
  assert.equal(updates.find((update) => update.id === 'edit-miss')?.meta, undefined);
  assert.equal(updates.some((update) => update.id === 'empty-todos'), true);

  const unnamed = scripted([json({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })]);
  const quiet = await createCursorCliSession({ provider: 'cursor', backend: 'cli', cwd, model: '', storagePath: cwd }, unnamed.spawn);
  const quietUpdates: AgentUpdate[] = [];
  await quiet.run('hi', new AbortController().signal, (update) => quietUpdates.push(update));
  assert.equal(quiet.sessionId, undefined);
  assert.equal(quietUpdates.at(-1)?.text, 'hi');

  const titled = scripted([
    json({ type: 'system', session_id: 'empty-title' }),
    json({ type: 'assistant', message: { content: [{ type: 'text', text: 'plan body' }] } }),
  ]);
  const identities: string[] = [];
  const planned = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: 'composer', storagePath: cwd, mode: 'plan',
    onIdentity: (identity) => identities.push(identity.title),
  }, titled.spawn);
  const planUpdates: AgentUpdate[] = [];
  await planned.run('', new AbortController().signal, (update) => planUpdates.push(update));
  assert.deepEqual(identities, ['Cursor', 'Cursor']);
  assert.equal(planUpdates.filter((update) => update.meta?.type === 'plan').at(-1)?.text, 'plan body');

  const badResult = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: '', storagePath: cwd,
  }, scripted([json({ type: 'result', is_error: true, result: 'bad result' })]).spawn);
  await assert.rejects(badResult.run('x', new AbortController().signal, () => undefined), /bad result/);
  const emptyResult = await createCursorCliSession({
    provider: 'cursor', backend: 'cli', cwd, model: '', storagePath: cwd,
  }, scripted([json({ type: 'result', is_error: true, result: '' })]).spawn);
  await assert.rejects(emptyResult.run('x', new AbortController().signal, () => undefined), /失敗しました/);

  const pausing = scripted([json({ type: 'system', session_id: 'live' })], { pause: true });
  const live = await createCursorCliSession({ provider: 'cursor', backend: 'cli', cwd, model: '', storagePath: cwd }, pausing.spawn);
  const pending = live.run('stop', new AbortController().signal, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await live.dispose();
  await assert.rejects(pending, /SIGTERM/);
});

test('Codex CLI forwards reasoning snapshots without inventing text from usage', async (t) => {
  const cwd = await directory(t);
  const events = scripted([
    json({ type: 'item.started', item: { id: 'r', type: 'reasoning', text: '' } }),
    json({ type: 'item.updated', item: { id: 'r', type: 'reasoning', text: 'First' } }),
    json({ type: 'item.updated', item: { id: 'r', type: 'reasoning', text: 'First second' } }),
    json({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'First second' } }),
    json({ type: 'item.completed', item: { id: 'invalid', type: 'reasoning', text: ['unsupported'] } }),
    json({ type: 'item.completed', item: { id: 'future', type: 'future_reasoning', text: 'ignored' } }),
    json({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Answer' } }),
    json({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 9 } }),
  ]);
  const session = await createCodexCliSession({ provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never' }, { spawn: events.spawn });
  const updates: AgentUpdate[] = [];
  await session.run('prompt', new AbortController().signal, (update) => updates.push(update));
  assert.deepEqual(updates.filter((item) => item.meta?.type === 'thinking').map(({ id, text }) => ({ id, text })), [
    { id: 'r', text: 'First' }, { id: 'r', text: 'First second' }, { id: 'r', text: 'First second' },
  ]);
  assert.equal(updates.find((item) => item.id === 'a')?.text, 'Answer');
  assert.equal(updates.some((item) => item.id === 'invalid' || item.id === 'future'), false);
  await session.dispose();
});

test('Codex CLI accepts every thread item and uses the real executable when no spawn is injected', async (t) => {
  const bare = codexCliArgs({ cwd: '/work', sandbox: 'other' });
  assert.equal(bare[bare.indexOf('-s') + 1], 'workspace-write');
  assert.equal(bare.includes('-i'), false);
  const full = codexCliArgs({
    cwd: '/work', model: 'gpt', effort: 'high', sandbox: 'danger-full-access', network: true, webSearch: 'live',
    additionalDirectories: ['/extra'], resumeId: 'thread', images: ['/pic.png'],
  });
  assert.equal(full[full.indexOf('-s') + 1], 'danger-full-access');
  assert.equal(full[full.indexOf('-i') + 1], '/pic.png');
  assert.equal(full.at(-1), 'thread');

  const cwd = await directory(t);
  const events = scripted([
    '',
    'not json',
    'null',
    json({ type: 1 }),
    json({ type: 'notice' }),
    json({ type: 'thread.started' }),
    json({ type: 'turn.completed', usage: null }),
    json({ type: 'turn.completed', usage: [] }),
    json({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    json({ type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0, cache_write_input_tokens: 4 } }),
    json({ type: 'item.completed', item: null }),
    json({ type: 'item.completed', item: { id: 'x' } }),
    json({ type: 'item.completed', item: { id: 'bad-error', type: 'error' } }),
    json({ type: 'item.completed', item: { id: 'error', type: 'error', message: 'bad item' } }),
    json({ type: 'item.started', item: { id: 'partial-command', type: 'command_execution', command: 'pwd', status: 'running' } }),
    json({ type: 'item.updated', item: { id: 'command', type: 'command_execution', command: 'pwd', aggregated_output: 'ok', status: 'completed' } }),
    json({ type: 'item.completed', item: { id: 'bad-file', type: 'file_change', status: 'completed', changes: [{ path: 'a' }, 'nope'] } }),
    json({ type: 'item.completed', item: { id: 'file', type: 'file_change', status: 'completed', changes: [{ path: 'b.txt', kind: 'update' }] } }),
    json({ type: 'item.completed', item: { id: 'bad-mcp', type: 'mcp_tool_call', server: 'docs' } }),
    json({ type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', status: 'completed' } }),
    json({ type: 'item.completed', item: { id: 'bad-search', type: 'web_search' } }),
    json({ type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'docs' } }),
    json({ type: 'item.completed', item: { id: 'bad-todos', type: 'todo_list', items: [{ text: 'ship' }] } }),
    json({ type: 'item.completed', item: { id: 'todos', type: 'todo_list', items: [{ text: 'ship', completed: false }, { text: 'done', completed: true }] } }),
    json({ type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'think' } }),
    json({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'hi' } }),
    json({ type: 'thread.started', thread_id: 'thread-real' }),
  ]);
  const identities: string[] = [];
  const session = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: 'gpt', storagePath: cwd, approval: 'never',
    onIdentity: (identity) => identities.push(identity.title),
  }, { spawn: events.spawn });
  await session.setModel!({ provider: 'codex', cwd, model: 'gpt-high', modelParams: [{ id: 'modelReasoningEffort', value: 'high' }] });
  await session.setModel!({ provider: 'codex', cwd, model: 'gpt-plain', modelParams: [{ id: 'other', value: 'x' }] });
  await session.setModel!({ provider: 'codex', cwd, model: 'gpt-plain' });
  const updates: AgentUpdate[] = [];
  await session.run('', new AbortController().signal, (update) => updates.push(update));
  assert.equal(session.sessionId, 'thread-real');
  assert.deepEqual(identities, ['Codex', 'Codex']);
  assert.equal(updates.find((update) => update.id === 'command')?.tool?.target, 'pwd');
  assert.equal(updates.find((update) => update.id === 'file')?.meta?.files?.[0]?.path, 'b.txt');
  assert.equal(updates.find((update) => update.id === 'mcp')?.tool?.name, 'docs/lookup');
  assert.equal(updates.find((update) => update.id === 'search')?.text, 'Search: docs');
  assert.equal(updates.find((update) => update.id === 'todos')?.meta?.todos?.[1]?.status, 'completed');
  assert.equal(updates.find((update) => update.id === 'error')?.role, 'error');
  assert.deepEqual(updates.find((update) => update.id === 'reason'), { id: 'reason', role: 'assistant', text: 'think', meta: { type: 'thinking', thinkingCompleted: true } });
  assert.equal(updates.find((update) => update.id === 'answer')?.text, 'hi');
  assert.equal(updates.filter((update) => update.meta?.type === 'usage').length, 1);
  await session.dispose();

  const unnamed = scripted([json({ type: 'turn.completed' })]);
  const quietIdentities: string[] = [];
  const quiet = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never',
    onIdentity: (identity) => quietIdentities.push(identity.title),
  }, { spawn: unnamed.spawn });
  await quiet.run('prompt', new AbortController().signal, () => undefined);
  assert.equal(quietIdentities.length, 0);

  for (const [line, pattern] of [
    [json({ type: 'turn.failed' }), /失敗しました/],
    [json({ type: 'turn.failed', error: { message: '' } }), /失敗しました/],
    [json({ type: 'turn.failed', error: { message: 4 } }), /失敗しました/],
    [json({ type: 'error' }), /失敗しました/],
    [json({ type: 'error', message: 'cli failed' }), /cli failed/],
  ] as const) {
    const failing = scripted([line]);
    const failed = await createCodexCliSession({
      provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never',
    }, { spawn: failing.spawn });
    await assert.rejects(failed.run('x', new AbortController().signal, () => undefined), pattern);
  }

  const pausing = scripted([json({ type: 'thread.started', thread_id: 'live' })], { pause: true });
  const live = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never',
  }, { spawn: pausing.spawn });
  const pending = live.run('stop', new AbortController().signal, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await live.dispose();
  await assert.rejects(pending, /SIGTERM/);

  const executable = path.join(cwd, 'codex.js');
  await writeFile(executable, `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'proc-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'from cli' } }) + '\\n');
`);
  const real = await createCodexCliSession({
    provider: 'codex', backend: 'cli', cwd, model: '', storagePath: cwd, approval: 'never', codexPath: executable,
  });
  const realUpdates: AgentUpdate[] = [];
  await real.run('hello', new AbortController().signal, (update) => realUpdates.push(update));
  assert.equal(real.sessionId, 'proc-thread');
  assert.equal(realUpdates.find((update) => update.id === 'answer')?.text, 'from cli');
  await real.dispose();
});
