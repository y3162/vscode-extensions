import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesFor, defaultControls } from '../../src/capabilities.js';
import { backendLabel, buildShell, countDiff, diffMessages, effortText, messageSignature, presentChange, toViewMessage } from '../../src/view-state.js';
import { emptyPlanState, type ChatState } from '../../src/types.js';

function state(extra: Partial<ChatState> = {}): ChatState {
  return {
    selection: { provider: 'codex', cwd: '/workspace', model: 'gpt', modelParams: [{ id: 'modelReasoningEffort', value: 'high' }] },
    busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [], ...extra,
  };
}

function shellFor(extra: Partial<ChatState> = {}, locale: 'ja' | 'en' = 'en', folders = [{ name: 'workspace', path: '/workspace' }]) {
  const controls = defaultControls('codex', 'app-server');
  return buildShell({
    state: state(extra), folders, modelLabel: 'GPT', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls, locale,
    tokens: { permission: null, plan: null, question: null },
    backends: { codex: 'app-server', cursor: 'sdk' },
  });
}

test('message diffs send only changed rows and file stats come from a diff', () => {
  const first = toViewMessage({ id: 'a', role: 'assistant', text: 'Hi' });
  assert.equal(messageSignature(first), JSON.stringify(first));
  assert.deepEqual((['sdk', 'acp', 'app-server'] as const).map((backend) => backendLabel(backend)), ['SDK', 'ACP', 'App Server']);
  const initial = diffMessages(new Map(), [first]);
  assert.deepEqual(initial.upserts.map((message) => message.id), ['a']);
  const next = diffMessages(initial.next, [first, toViewMessage({ id: 'b', role: 'assistant', text: 'There' })]);
  assert.deepEqual(next.upserts.map((message) => message.id), ['b']);
  assert.deepEqual(next.removed, []);
  const trimmed = diffMessages(next.next, [toViewMessage({ id: 'b', role: 'assistant', text: 'There' })]);
  assert.deepEqual(trimmed.removed, ['a']);
  assert.deepEqual(countDiff('--- a/x\n+++ b/x\n+added\n-gone\n'), { additions: 1, deletions: 1 });
  const synthetic = presentChange({ path: 'turn.diff', kind: 'update', diff: '+only\n' }, ['/workspace']);
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.canRevert, false);
  assert.equal(synthetic.patch, '+only\n');
  assert.equal(presentChange({ path: '/', kind: 'update' }, []).name, '/', 'a filesystem root has no basename');
  assert.deepEqual(presentChange({ path: 'partial.txt', kind: 'update', additions: 0 }, []), {
    path: 'partial.txt', name: 'partial.txt', kind: 'update', additions: 0,
    canRevert: false, canDiff: false, synthetic: false,
  }, 'a supplied zero count is retained without inventing a deletion count');
  assert.deepEqual(presentChange({ path: 'deleted.txt', kind: 'delete', deletions: 2 }, []), {
    path: 'deleted.txt', name: 'deleted.txt', kind: 'delete', deletions: 2,
    canRevert: false, canDiff: false, synthetic: false,
  });
});

test('parent wait text requires an explicit live backend wait event', () => {
  const turns = [{ id: 'turn-1', startedAt: 10, status: 'running' as const, waitMs: 0, mode: 'agent' as const, model: 'gpt', intent: 'chat' as const }];
  const children = [
    { id: 'a', parentTurnId: 'turn-1', name: 'A', status: 'running' as const, background: true as const },
    { id: 'b', parentTurnId: 'turn-1', name: 'B', status: 'unknown' as const, background: 'unknown' as const },
  ];
  const runningOnly = shellFor({ busy: true, status: 'running', turns, subagents: children });
  assert.equal(runningOnly.statusText, 'Running…');
  assert.equal(runningOnly.subagentWaiting, null);
  const waiting = shellFor({ busy: true, status: 'running', turns, subagents: children, subagentWaiting: { parentTurnId: 'turn-1', startedAt: 20 } });
  assert.equal(waiting.statusText, 'Waiting for subagents');
  assert.equal(waiting.presence, 'waiting');
  assert.deepEqual(waiting.subagentWaiting, { startedAt: 20, count: 2 });
  assert.equal(shellFor({ busy: false, status: 'idle', turns, subagents: children, subagentWaiting: { parentTurnId: 'turn-1', startedAt: 20 } }).subagentWaiting, null,
    'a stale persisted wait is hidden after the parent turn ends');
  assert.equal(shellFor({ busy: true, status: 'running', turns, subagents: children, subagentWaiting: { parentTurnId: 'turn-1', startedAt: 20 } }, 'ja').statusText, '複数のサブエージェントの完了を待機中');
});

test('message projection omits empty collections and planning can display the last saved plan', () => {
  const projected = toViewMessage({
    id: 'empty-meta', role: 'tool', text: '', meta: { type: 'files', files: [], todos: [] },
  });
  assert.deepEqual(projected.meta, { type: 'files' });

  const shell = shellFor({ plan: {
    phase: 'planning',
    current: { id: 'saved-plan', revision: 2, markdown: 'Saved while planning', todos: [], source: 'assistant-text', createdAt: 1 },
    revisions: [],
  } });
  assert.equal(shell.planView?.markdown, 'Saved while planning');
  assert.equal(shell.planView?.canBuild, false);
});

test('file diff previews survive the message projection to the webview', () => {
  const preview = [
    { kind: 'remove' as const, line: 3, text: 'before' },
    { kind: 'add' as const, line: 3, text: 'after' },
  ];
  const message = toViewMessage({
    id: 'files', role: 'tool', text: 'Changed README.md',
    meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', preview }] },
  });
  assert.deepEqual(message.meta?.files?.[0]?.preview, preview);
});

test('message projection preserves optional tool, attachment, and subagent metadata', () => {
  const projected = toViewMessage({
    id: 'subagent-event', role: 'assistant', text: 'delegated', turnId: 'turn-1',
    at: 42, final: true, failure: { kind: 'provider', retryable: true, operation: 'run' },
    attachments: ['notes.txt'], tool: { name: 'Read', kind: 'read', status: 'completed', target: 'notes.txt' },
    meta: {
      type: 'subagent',
      files: [{ path: 'notes.txt', kind: 'update', additions: 0, deletions: 1 }],
      todos: [{ content: 'inspect', status: 'completed' }],
      task: 'inspect notes', imagePath: '/tmp/diagram.png',
      subagent: {
        id: 'child-1', name: 'Researcher', task: 'inspect notes', status: 'completed',
        background: false, durationMs: 1200, resultPreview: 'Found one note.',
      },
    },
  });

  assert.equal(projected.turnId, 'turn-1');
  assert.equal(projected.at, 42);
  assert.equal(projected.final, true);
  assert.deepEqual(projected.failure, { kind: 'provider', retryable: true, operation: 'run' });
  assert.deepEqual(projected.attachments, ['notes.txt']);
  assert.deepEqual(projected.tool, { name: 'Read', kind: 'read', status: 'completed', target: 'notes.txt' });
  assert.deepEqual(projected.meta, {
    type: 'subagent',
    files: [{ path: 'notes.txt', kind: 'update', additions: 0, deletions: 1 }],
    todos: [{ content: 'inspect', status: 'completed' }],
    task: 'inspect notes',
    imagePath: '/tmp/diagram.png',
    subagent: {
      id: 'child-1', name: 'Researcher', task: 'inspect notes', status: 'completed',
      background: false, durationMs: 1200, resultPreview: 'Found one note.',
    },
  });
});

test('projection retains child recovery details and omits a zero live-child count', () => {
  const child = {
    id: 'child', parentTurnId: 'turn-1', agentId: 'agent-1', model: 'gpt', name: 'Researcher',
    task: 'Search files', taskOmitted: true, status: 'completed' as const, background: false as const,
    startedAt: 1, endedAt: 2, progress: 'Done', error: 'Partial failure', historyOmitted: true,
  };
  const projected = toViewMessage({
    id: 'child-message', role: 'tool', text: 'details', subagentId: 'child', meta: { type: 'subagent', subagent: child },
  });
  assert.equal(projected.subagentId, 'child');
  assert.deepEqual(projected.meta?.subagent, child);
  const turn = { id: 'turn-1', startedAt: 1, status: 'running' as const, waitMs: 0, mode: 'agent' as const, model: 'gpt', intent: 'chat' as const };
  const waiting = shellFor({
    busy: true, turns: [turn], subagents: [child], subagentWaiting: { parentTurnId: 'turn-1', startedAt: 3 },
    terminals: [{ processId: 'terminal', outputError: 'Output incomplete' }],
  }, 'ja');
  assert.deepEqual(waiting.subagents[0], child);
  assert.deepEqual(waiting.subagentWaiting, { startedAt: 3 });
  assert.equal(waiting.statusText, 'サブエージェントの完了を待機中');
  assert.equal(waiting.terminals[0]?.outputError, 'Output incomplete');
});

test('unknown planning phase shows its saved draft when present', () => {
  const shell = shellFor({ plan: {
    phase: 'unknown',
    current: { id: 'current', revision: 1, markdown: 'Original', todos: [], source: 'assistant-text', createdAt: 1 },
    draft: { id: 'draft', revision: 2, markdown: 'Recovered draft', todos: [], source: 'assistant-text', createdAt: 2 },
    revisions: [],
  } });
  assert.equal(shell.planView?.markdown, 'Recovered draft');
});

test('shell projection retains saved conversation, build inputs, usage, queue, and live process state', () => {
  const usage = { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 };
  const sourceState = state({
    busy: false,
    status: 'running',
    usage,
    selection: { provider: 'codex', cwd: '/workspace', model: 'gpt-chat', modelParams: [{ id: 'reasoning_effort', value: 'high' }] },
    messages: [{ id: 'user', role: 'user', text: 'Plan the release\nwith tests' }],
    queue: [{ id: 'queued', text: 'raw prompt', extras: { displayText: 'visible prompt', images: [{ mimeType: 'image/png', data: 'synthetic' }] } }],
    changes: [
      { path: '/workspace/README.md', kind: 'update', previousText: 'before\n', additions: 2, deletions: 1 },
      { path: 'turn.diff', kind: 'update', diff: '+one\n' },
    ],
    sessions: [
      { id: 'saved', conversationId: 'backend-thread', title: 'Release planning', updatedAt: '2026-10-17T00:00:00Z', provider: 'codex', cwd: '/workspace' },
      { id: 'other-provider', title: 'Cursor session', updatedAt: '2026-10-17T00:01:00Z', provider: 'cursor', cwd: '/workspace' },
    ],
    plan: {
      phase: 'ready',
      current: { id: 'plan-2', revision: 2, overview: 'Ship a small change', markdown: '## Steps', todos: [{ content: 'Run checks', status: 'completed' }], files: ['README.md'], source: 'app-server-plan', createdAt: 10 },
      revisions: [
        { revision: 1, createdAt: 5, source: 'app-server-plan', name: 'Draft', markdown: 'Old steps' },
        { revision: 2, createdAt: 10, source: 'app-server-plan', markdown: '## Steps' },
      ],
      build: { selection: { provider: 'codex', cwd: '/workspace', model: 'gpt-build', modelParams: [{ id: 'reasoning_effort', value: 'medium' }] }, label: 'Build model' },
    },
    turns: [{ id: 'turn-1', startedAt: 1, endedAt: 4, status: 'completed', waitMs: 2, mode: 'agent', model: 'gpt-chat', intent: 'chat', finalMessageId: 'final-1', usage }],
    subagents: [{ id: 'child-1', agentId: 'agent-1', model: 'gpt-mini', name: 'Researcher', task: 'check docs', status: 'completed', background: false, durationMs: 900, resultPreview: 'Found the note.' }],
    terminals: [{ processId: 'process-1', output: 'done\n', exitCode: 0, command: 'npm test', status: 'completed' }],
    terminalError: 'One terminal could not be restored',
  });
  const shell = buildShell({
    state: sourceState, folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'GPT', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls: defaultControls('codex', 'app-server'), locale: 'en',
    sessionId: 'saved', conversationId: 'conversation-1', showBuildModel: false,
    tokens: { permission: null, plan: null, question: null },
    backends: { codex: 'app-server', cursor: 'sdk' },
  });

  assert.equal(shell.presence, 'running');
  assert.equal(shell.statusText, 'Running… · in 11 / out 7');
  assert.equal(shell.sessionTitle, 'Release planning');
  assert.deepEqual(shell.sessions.map((item) => item.id), ['saved']);
  assert.equal(shell.conversationId, 'conversation-1');
  assert.equal(shell.effortLabel, 'High');
  assert.deepEqual(shell.queue, [{ id: 'queued', text: 'visible prompt', images: 1 }]);
  assert.deepEqual(shell.changes.map((item) => [item.name, item.canRevert, item.synthetic]), [
    ['README.md', true, false], ['Patch', false, true],
  ]);
  assert.equal(shell.additions, 3);
  assert.equal(shell.deletions, 1);
  assert.equal(shell.planView?.canBuild, true);
  assert.equal(shell.planView?.buildModelId, 'gpt-build');
  assert.equal(shell.planView?.buildModelLabel, 'Build model');
  assert.equal(shell.planView?.showBuildModel, false);
  assert.deepEqual(shell.planView?.history.map((item) => item.revision), [1]);
  assert.deepEqual(shell.timings[0], {
    id: 'turn-1', startedAt: 1, endedAt: 4, waitMs: 2, status: 'completed', intent: 'chat', usage, finalMessageId: 'final-1',
  });
  assert.deepEqual(shell.subagents[0], {
    id: 'child-1', agentId: 'agent-1', model: 'gpt-mini', name: 'Researcher', task: 'check docs',
    status: 'completed', background: false, durationMs: 900, resultPreview: 'Found the note.',
  });
  assert.deepEqual(shell.terminals[0], { processId: 'process-1', output: 'done\n', exitCode: 0, command: 'npm test', status: 'completed' });
  assert.equal(shell.terminalError, 'One terminal could not be restored');
});

test('status labels cover rewind operations, approval waits, failure, and missing workspaces', () => {
  const operations = [
    ['rewind-check', 'Checking rewind safety…', '巻き戻し可否を確認中…'],
    ['rewind-branch', 'Branching conversation…', '会話を分岐中…'],
    ['rewind-files', 'Restoring files…', 'ファイルを復元中…'],
    ['rewind-prepare', 'Preparing edited prompt…', '編集した依頼を準備中…'],
    ['rewind-send', 'Running edited prompt…', '編集した依頼を実行中…'],
  ] as const;
  for (const [operationLabel, english, japanese] of operations) {
    assert.equal(shellFor({ operationLabel }, 'en').statusText, english);
    assert.equal(shellFor({ operationLabel }, 'ja').statusText, japanese);
  }
  assert.equal(shellFor({ pendingQuestion: { id: 'q', questions: [{ id: 'q1', prompt: 'Choose', options: [] }] } }, 'en').statusText, 'Waiting for approval');
  assert.equal(shellFor({ pendingPermission: { id: 'p', title: 'Read', detail: 'file', kind: 'read' } }, 'ja').statusText, '承認待ち');
  assert.equal(shellFor({ status: 'cancelling' }, 'en').statusText, 'Stopping…');
  assert.equal(shellFor({ status: 'restoring' }, 'ja').statusText, '復元中…');
  assert.equal(shellFor({ status: 'error' }, 'en').statusText, 'Error');
  assert.equal(shellFor({ busy: true }, 'ja').statusText, '実行中…');
  assert.equal(shellFor().statusText, 'Ready');
  assert.equal(shellFor({}, 'en', []).statusText, 'Open a workspace folder');
});

test('pending interaction payloads require their matching tokens', () => {
  const sourceState = state({
    pendingPermission: { id: 'permission', title: 'Write file', detail: 'README.md', kind: 'write' },
    pendingPlan: { id: 'plan-request', overview: 'Small change', plan: 'Do it', todos: [] },
    pendingQuestion: { id: 'question', questions: [{ id: 'q1', prompt: 'Choose one', options: [{ id: 'a', label: 'A' }] }] },
  });
  const source = {
    state: sourceState, folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'GPT', hasModelDetails: false,
    capabilities: capabilitiesFor('codex', 'app-server'), controls: defaultControls('codex', 'app-server'), locale: 'en' as const,
    tokens: { permission: 'permission-token', plan: 'plan-token', question: 'question-token' },
    backends: { codex: 'app-server' as const, cursor: 'sdk' as const },
    activeFile: { label: 'README.md', token: 'active-file-token' },
  };
  const shell = buildShell(source);
  assert.deepEqual(shell.permission, { token: 'permission-token', request: sourceState.pendingPermission });
  assert.deepEqual(shell.plan, { token: 'plan-token', request: sourceState.pendingPlan });
  assert.deepEqual(shell.question, { token: 'question-token', request: sourceState.pendingQuestion });
  assert.deepEqual(shell.activeFile, { label: 'README.md', token: 'active-file-token' });
  const noTokens = buildShell({ ...source, tokens: { permission: null, plan: null, question: null } });
  assert.equal(noTokens.permission, null);
  assert.equal(noTokens.plan, null);
  assert.equal(noTokens.question, null);
});

test('draft plans take precedence while revising and stale saved titles fall back to the user prompt', () => {
  const promptTitle = `  ${'release '.repeat(12)}\nsecond line`;
  const sourceState = state({
    messages: [{ id: 'user', role: 'user', text: promptTitle }],
    sessions: [{ id: 'session', title: 'New chat', updatedAt: 'now', provider: 'cursor' }],
    plan: {
      phase: 'revising',
      current: { id: 'current', revision: 2, markdown: 'current plan', todos: [], source: 'assistant-text', createdAt: 1 },
      draft: { id: 'draft', revision: 3, name: 'Updated plan', overview: 'Revised scope', markdown: 'draft plan', todos: [], files: ['src/new.ts'], restored: true, source: 'assistant-text', createdAt: 2 },
      revisions: [
        { revision: 1, createdAt: 0, source: 'assistant-text', markdown: 'first' },
        { revision: 2, createdAt: 1, source: 'assistant-text', name: 'Current', markdown: 'current plan' },
      ],
      error: 'Build unavailable',
    },
  });
  const shell = buildShell({
    state: sourceState, folders: [], modelLabel: '', hasModelDetails: false,
    capabilities: capabilitiesFor('codex', 'app-server'), controls: defaultControls('codex', 'app-server'), locale: 'en',
    sessionId: 'session', tokens: { permission: null, plan: null, question: null },
    backends: { codex: 'app-server', cursor: 'sdk' },
  });

  assert.equal(shell.sessionTitle, promptTitle.split('\n')[0]!.trim().slice(0, 80));
  assert.equal(shell.folderName, 'No folder');
  assert.equal(shell.planView?.id, 'draft');
  assert.equal(shell.planView?.name, 'Updated plan');
  assert.equal(shell.planView?.overview, 'Revised scope');
  assert.deepEqual(shell.planView?.files, ['src/new.ts']);
  assert.equal(shell.planView?.restored, true);
  assert.equal(shell.planView?.canBuild, false);
  assert.equal(shell.planView?.buildModelId, 'gpt');
  assert.equal(shell.planView?.showBuildModel, true);
  assert.equal(shell.planView?.error, 'Build unavailable');
  assert.deepEqual(shell.planView?.history.map((item) => item.revision), [1, 2]);

  const noTitle = shellFor({ messages: [], sessions: [] }, 'ja');
  assert.equal(noTitle.sessionTitle, '新しいチャット');
  assert.equal(noTitle.planView, null);
});

test('access warnings distinguish automatic approval, disabled sandbox, and Cursor confirmation', () => {
  const makeSource = (
    sourceState: ChatState,
    controls: ReturnType<typeof defaultControls>,
    capabilities: ReturnType<typeof capabilitiesFor>,
    locale: 'ja' | 'en',
  ) => ({
    state: sourceState, folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: '', hasModelDetails: false,
    controls, capabilities, locale,
    tokens: { permission: null, plan: null, question: null },
    backends: { codex: 'app-server' as const, cursor: 'acp' as const },
  });

  const autoControls = { ...defaultControls('codex', 'app-server'), sandbox: 'workspace-write', approval: 'on-request' };
  const auto = buildShell(makeSource(state({ autoApprove: true }), autoControls, capabilitiesFor('codex', 'app-server'), 'en'));
  assert.equal(auto.accessLabel, 'Workspace write · On request');
  assert.equal(auto.risky, true);
  assert.equal(auto.banner?.title, 'Auto-approve is on');
  assert.match(auto.banner?.body ?? '', /does not turn the sandbox off/);

  const disabledControls = { ...defaultControls('codex', 'app-server'), sandbox: 'disabled' };
  const disabled = buildShell(makeSource(state(), disabledControls, capabilitiesFor('codex', 'app-server'), 'ja'));
  assert.equal(disabled.risky, true);
  assert.equal(disabled.banner?.title, 'サンドボックスがオフです');

  const cursorControls = defaultControls('cursor', 'acp');
  const cursor = buildShell(makeSource(
    state({ selection: { provider: 'cursor', cwd: '/workspace', model: 'auto' } }),
    cursorControls,
    capabilitiesFor('cursor', 'acp'),
    'ja',
  ));
  assert.equal(cursor.accessLabel, 'Sandbox · ツールごとに確認');
  assert.equal(cursor.risky, false);
  assert.equal(cursor.banner, null);
});

test('the access banner follows the real sandbox and can be dismissed', () => {
  const controls = { ...defaultControls('codex', 'app-server'), sandbox: 'danger-full-access', approval: 'on-request' };
  const source = {
    state: state(), folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'gpt', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls, locale: 'ja' as const,
    tokens: { permission: null, plan: null, question: null }, dismissedWarning: null,
    backends: { codex: 'app-server' as const, cursor: 'sdk' as const },
  };
  const shell = buildShell(source);
  assert.equal(shell.accessLabel, 'Full access · On request');
  assert.equal(shell.risky, true);
  assert.equal(shell.banner?.title, 'フルアクセスがオンです');
  assert.equal(shell.effortLabel, 'High');
  assert.equal(shell.modelSettings, 'next-send');
  assert.equal(shell.showMode, true);
  const hidden = buildShell({ ...source, dismissedWarning: shell.banner?.id });
  assert.equal(hidden.banner, null);
  assert.equal(hidden.risky, true);
  const sdk = buildShell({
    ...source,
    capabilities: capabilitiesFor('codex', 'sdk'),
    controls: defaultControls('codex', 'sdk'),
  });
  assert.equal(sdk.showMode, false);
  assert.equal(sdk.banner, null);
});

test('rewind progress and a busy plan are visible without offering Build', () => {
  const controls = defaultControls('codex', 'app-server');
  const source = {
    state: state({
      busy: true,
      status: 'restoring' as const,
      operationLabel: 'rewind-branch' as const,
      plan: {
        phase: 'ready' as const,
        revisions: [],
        error: 'revision failed',
        current: { id: 'plan-1', revision: 2, markdown: 'Do the thing', todos: [], source: 'assistant-text' as const, createdAt: 1 },
      },
    }),
    folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'gpt', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls, locale: 'en' as const,
    tokens: { permission: null, plan: null, question: null }, dismissedWarning: null,
    backends: { codex: 'app-server' as const, cursor: 'sdk' as const },
  };
  const shell = buildShell(source);
  assert.equal(shell.statusText.startsWith('Branching conversation…'), true);
  assert.equal(shell.planView?.canBuild, false);
  assert.equal(shell.planView?.error, 'revision failed');
  assert.equal(shell.presence, 'running');
  const user = toViewMessage({ id: 'user', role: 'user', text: 'edit me' }, true);
  const answer = toViewMessage({ id: 'answer', role: 'assistant', text: 'done' }, true);
  assert.equal(user.canRewind, true);
  assert.equal(answer.canRewind, undefined);
});

test('cancelling, restoring, and failed statuses have localized labels', () => {
  assert.equal(shellFor({ status: 'cancelling' }).statusText, 'Stopping…');
  assert.equal(shellFor({ status: 'restoring' }, 'ja').statusText, '復元中…');
  assert.equal(shellFor({ status: 'error' }).statusText, 'Error');
  assert.equal(shellFor({ status: 'error' }, 'ja').statusText, 'エラー');
});

test('missing effort details stay blank and a fast flag is not shown as effort', () => {
  assert.equal(effortText(undefined, true, 'en'), null);
  assert.equal(effortText([{ id: 'fast', value: 'true' }], true, 'en'), null);
  assert.equal(effortText([{ id: 'modelReasoningEffort', value: 'xhigh' }], false, 'ja'), 'Extra High');
});
