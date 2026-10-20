import { createGitFixture, snapshotGitFixture } from '../../support/git-fixture.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../../../src/providers/codex-app-server.js';
import type { AgentUpdate } from '../../../src/types.js';

test('App Server reconciles terminal output, malformed subagent reads, questions, todos, and rename baselines', { timeout: 12000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-app-server-round6-'));
  const cwd = path.join(root, 'workspace');
  const command = path.join(root, 'synthetic-app-server.cjs');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'old.txt'), 'original file\n');
  createGitFixture(cwd);
  snapshotGitFixture(cwd);

  const source = String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let activeStart;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start') {
    emit({ method: 'turn/completed', params: {} });
    emit({ id: request.id, result: { thread: { id: 'parent-thread', historyMode: 'paginated' } } });
  }
  else if (request.method === 'thread/list') emit({ id: request.id, result: { data: [
    { id: 'listed-thread', title: '', preview: 'preview title', updatedAt: 'now' },
    { id: 'fallback-title', preview: 5 },
  ] } });
  else if (request.method === 'thread/fork') emit({ id: request.id, result: {} });
  else if (request.method === 'thread/backgroundTerminals/list') emit({ id: request.id, result: { data: [
    { processId: 'proc-live', itemId: 'cmd-live', command: 'long command' },
    { processId: 'proc-complete', itemId: 'cmd-complete', command: 'finished command' },
  ] } });
  else if (request.method === 'turn/start') {
    activeStart = request.id;
    emit({ method: 'turn/started', params: { threadId: 'parent-thread', turn: { id: 'round6-turn' } } });
    emit({ method: 'item/started', params: { threadId: 'parent-thread', item: { type: 'subAgentActivity', agentThreadId: 'child-empty-history', kind: 'started' } } });
    emit({ method: 'item/started', params: { threadId: 'parent-thread', item: { type: 'subAgentActivity', agentThreadId: 'child-bad-items', kind: 'mystery' } } });
    emit({ method: 'item/started', params: { threadId: 'parent-thread', item: { type: 'spawnAgent', receiverThreadId: 'child-spawn', tool: 'spawn' } } });
    emit({ method: 'turn/started', params: { threadId: 'child-spawn', turn: { id: 'spawn-turn' } } });
    emit({ method: 'turn/completed', params: { threadId: 'child-spawn', turn: { id: 'spawn-turn', status: 'completed' } } });
    emit({ method: 'item/completed', params: { threadId: 'child-empty-history', item: { type: 'agentMessage', id: 'child-message', text: 'child notification' } } });
    emit({ method: 'item/updated', params: { threadId: 'child-empty-history', item: { type: 'subAgentActivity', agentThreadId: 'nested-child', kind: 'started' } } });
    emit({ method: 'thread/tokenUsage/updated', params: { inputTokens: 12, outputTokens: 3 } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'parent-thread', itemId: 'cmd-live', delta: 'initial output' } });
    emit({ method: 'item/updated', params: { threadId: 'parent-thread', item: { id: 'cmd-live', type: 'commandExecution', processId: 'proc-live', command: 'long command', status: 'running', aggregatedOutput: 'seed output' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'parent-thread', itemId: 'cmd-live', delta: 'latest output' } });
    emit({ method: 'item/updated', params: { threadId: 'parent-thread', item: { id: 'cmd-live', type: 'commandExecution', processId: 'proc-live', command: 'long command' } } });
    emit({ method: 'item/completed', params: { threadId: 'parent-thread', item: { id: 'cmd-complete', type: 'commandExecution', processId: 'proc-complete', command: 'finished command', status: 'completed', aggregatedOutput: 'done', exitCode: 0 } } });
    emit({ method: 'item/updated', params: { threadId: 'parent-thread', item: { id: 'cmd-complete', type: 'commandExecution', processId: 'proc-complete', command: 'finished command' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'parent-thread', itemId: 'cmd-detached', delta: 'detached output' } });
    emit({ method: 'item/started', params: { threadId: 'parent-thread', item: { id: 'cmd-detached', type: 'commandExecution', command: 'detached command', exitCode: 7 } } });
    emit({ method: 'item/completed', params: { threadId: 'parent-thread', item: { id: 'todo-fallback', type: 'todoList', items: null, todos: [{ text: 'fallback todo' }] } } });
    emit({ method: 'item/completed', params: { threadId: 'parent-thread', item: { id: 'generic-tool', type: 'mcpToolCall', text: 'synthetic generic tool' } } });
    emit({ method: 'item/completed', params: { threadId: 'parent-thread', item: { id: 'rename-item', type: 'fileChange', changes: [{ path: 'old.txt', kind: { type: 'update', move_path: 'new.txt' }, diff: '@@ -1 +1 @@\n-original file\n+renamed file\n' }] } } });
    emit({ method: 'turn/diff/updated', params: { threadId: 'parent-thread', turn: { id: 'round6-turn' }, diff: 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-original file\n+renamed file\n' } });
    emit({ id: 50, method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'header-question', header: 'Header fallback', options: [{ label: 'Yes' }, { label: 5 }] },
      { id: 'plain-question', question: 'Direct prompt', options: 'malformed' },
      { header: 'Missing id is filtered' },
    ] } });
  }
  else if (request.id === 50) emit({ id: 51, method: 'item/tool/requestUserInput', params: { itemId: 'empty-questions', questions: 'malformed' } });
  else if (request.id === 51) {
    emit({ method: 'turn/completed', params: { threadId: 'parent-thread', turn: { id: 'round6-turn', status: 'completed' } } });
    emit({ id: activeStart, result: { turn: { id: 'round6-turn' } } });
    activeStart = undefined;
  }
  else if (request.method === 'thread/read' && request.params.threadId === 'child-empty-history') {
    emit({ id: request.id, result: { thread: { turns: null } } });
  }
  else if (request.method === 'thread/read' && request.params.threadId === 'child-bad-items') {
    emit({ id: request.id, result: { thread: { status: { type: 'idle' }, turns: [{ status: 'failed', items: 'malformed' }] } } });
  }
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});

`;
  await writeFile(command, source);
  await chmod(command, 0o700);

  const answers: Array<{ id: string; questions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string }> }> }> = [];
  const session = await createCodexAppServerSession({
    provider: 'codex', cwd, model: 'fixture-model', storagePath: path.join(root, 'storage'), codexPath: command,
    interactions: {
      async requestPermission() { return 'deny'; },
      async requestPlan() { return 'rejected'; },
      async requestAnswers(request) { answers.push(request); return { 'header-question': ['Yes'] }; },
    },
  });
  const live: AgentUpdate[] = [];
  const background: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => background.push(update));
  try {
    assert.deepEqual((await session.listBackgroundTerminals?.())?.map((row) => row.processId), ['proc-live', 'proc-complete']);
    assert.deepEqual((await session.listSessions?.())?.map((row) => [row.id, row.title]), [
      ['listed-thread', 'preview title'], ['fallback-title', 'fallback-title'],
    ]);
    await session.run('reconcile synthetic state', new AbortController().signal, (update) => live.push(update));
    assert.deepEqual(answers, [
      { id: 'question', questions: [
        { id: 'header-question', prompt: 'Header fallback', options: [{ id: 'Yes', label: 'Yes' }] },
        { id: 'plain-question', prompt: 'Direct prompt', options: [] },
      ] },
      { id: 'empty-questions', questions: [] },
    ]);

    const liveCommand = live.filter((update) => update.id === 'cmd-detached').at(-1);
    assert.equal(liveCommand?.text, 'detached command\ndetached output');
    assert.equal(liveCommand?.tool?.exitCode, 7);
    const commandUpdates = background.filter((update) => update.id === 'cmd-live');
    assert.equal(commandUpdates.at(-1)?.tool?.status, 'running', 'an update without status retains the running command state');
    assert.equal(commandUpdates.at(-1)?.text, 'long command\ninitial outputlatest output', 'buffered output is attached to the saved process record');
    assert.equal(background.some((update) => update.id === 'cmd-complete'), true);
    assert.equal(background.filter((update) => update.id === 'cmd-complete').at(-1)?.text, 'finished command\ndone', 'saved output survives a later sparse item update');
    assert.equal(background.filter((update) => update.id === 'cmd-complete').some((update) => update.tool?.exitCode === 0), true);
    assert.equal(live.some((update) => update.meta?.type === 'todo' && update.meta.todos?.[0]?.content === 'fallback todo'), true);
    assert.equal(live.find((update) => update.id === 'generic-tool')?.tool?.name, 'mcptoolcall');
    assert.equal(live.some((update) => update.meta?.usage?.inputTokens === 12 && update.meta.usage.outputTokens === 3), true);
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-spawn' && update.meta.subagent.status === 'completed'), true);
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-empty-history' && update.meta.subagent.resultPreview === 'child notification'), true);
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'nested-child' && update.meta.subagent.status === 'running'), true);

    const deadline = Date.now() + 2800;
    while (!background.some((update) => update.meta?.subagent?.id === 'child-bad-items' && update.meta.subagent.status === 'error') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-bad-items' && update.meta.subagent.status === 'error'), true,
      'a failed child with malformed items is reconciled without fabricating a preview');
    assert.equal(background.some((update) => update.meta?.subagent?.id === 'child-empty-history' && update.meta.subagent.status === 'completed'), false,
      'an empty child history keeps its prior status');

    const rename = live.find((update) => update.text === 'diff updated' && update.meta?.files?.some((file) => file.path === 'new.txt'));
    assert.equal(rename?.meta?.files?.[0]?.oldPath, 'old.txt');
    const baseline = background.find((update) => update.id.startsWith('workspace-changes:'));
    assert.equal(baseline?.meta?.files?.some((file) => file.path.endsWith('/new.txt') && file.oldPath?.endsWith('/old.txt') && file.previousText === 'original file\n'), true,
      `the rename retains the committed source text for safe review: ${JSON.stringify(baseline?.meta?.files)}`);
    const terminalState = await session.listBackgroundTerminals?.();
    assert.deepEqual(terminalState?.map((row) => row.processId), ['proc-live'], 'a completed command is excluded from the refreshed terminal list');
    assert.equal(await session.fork?.(), undefined, 'a fork response without a thread id does not create a usable branch');
    session.activateFork?.('parent-thread');
    assert.equal(session.rewindUnsupportedReason?.(), undefined, 'the owned source thread retains its advertised paginated history mode');
  } finally {
    unsubscribe();
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

