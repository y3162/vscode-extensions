#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = process.env.APP_EDGE || '';
const mainThreadId = scenario === 'thread-fallback' ? 'fallback-thread' : 'thread-1';
const counter = process.env.EDGE_COUNTER || '';
const note = (method) => { if (counter) fs.appendFileSync(counter, `${method}\n`); };
let pending;
let hang = false;
let lateArmed = false;
let lateLists = 0;
let lastStart = {};
const threads = new Map([['thread-1', ['turn-a', 'turn-b']], ['thread-2', ['turn-a']], ['thread-9', ['nope']]]);

function complete(turnId, status = 'completed', extra = {}) {
  emit({ method: 'turn/completed', params: { threadId: mainThreadId, turn: { id: turnId, status, ...extra } } });
  emit({ id: pending, result: { turn: { id: turnId, status } } });
  pending = undefined;
}

function delta(itemId, text, method = 'item/agentMessage/delta') {
  emit({ method, params: { threadId: mainThreadId, itemId, delta: text } });
}

function item(method, body) {
  emit({ method, params: { threadId: mainThreadId, item: body } });
}

function historyTurns() {
  return [{
    id: 'saved',
    items: [
      { type: 'subAgentActivity', newThreadId: 'child-a', receiverThreadIds: ['child-a', 4], agentPath: '/root/a', kind: 'completed', model: 'm', agentsStates: { 'child-a': { status: 'completed', message: 'done' } } },
      { type: 'subAgentActivity', newThreadId: 'child-a', agentPath: '/root/a2', kind: 'failed', agentsStates: { 'child-a': { status: 'failed', message: 'x'.repeat(600) } } },
      { type: 'userMessage', text: 'question' },
      { type: 'errorMessage', message: 'bad' },
      { type: 'agentMessage', text: 'answer', phase: 'final_answer' },
      { type: 'agentMessage', text: 'note', phase: 'commentary' },
      { type: 'webSearch', query: 'q' },
      { type: 'commandExecution', command: 'ls' },
      { type: 'reasoning', content: [{ text: 'think' }] },
      { type: 'empty' },
      { type: 'userMessage', content: ['a', { text: 'b' }] },
    ],
  }];
}

function malformedHistoryTurns() {
  return [
    { items: { malformed: true } },
    { items: [
      { type: 'subAgentActivity', newThreadId: 'child-without-metadata' },
      { type: 'userMessage', id: 'user-without-turn-id', text: 'saved without a turn id' },
    ] },
  ];
}

function events() {
  emit({ method: 'item/completed', params: { threadId: 'other-thread', item: { type: 'agentMessage', id: 'secret', text: 'secret' } } });
  item('item/started', { type: 'commandExecution', id: 'cmd-no-pid', command: 'ls', status: 'in_progress', aggregatedOutput: 'listed' });
  item('item/started', { type: 'commandExecution', id: 'cmd-1', processId: 'proc-1', command: 'finite', status: 'inProgress' });
  delta('cmd-1', 'EARLY\n', 'item/commandExecution/outputDelta');
  item('item/completed', { type: 'commandExecution', id: 'cmd-1', processId: 'proc-1', command: 'finite', status: 'completed', aggregatedOutput: 'done', exitCode: 0 });
  item('item/started', { type: 'fileChange', id: 'file-1', status: 'in_progress', changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n' }] });
  item('item/completed', { type: 'fileChange', id: 'file-1', status: 'completed', changes: [
    { path: '', kind: 'update' },
    { path: 'from.ts', kind: { type: 'update', move_path: 'to.ts' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
    { path: 'old.ts', kind: { type: 'rename', movePath: 'src.ts' } },
    { path: 'z.ts', kind: 'delete', diff: 'diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n' },
    'skip',
  ] });
  item('item/completed', { type: 'fileChange', id: 'file-malformed', changes: 'not-an-array' });
  item('item/completed', { type: 'plan', id: 'plan-1', text: '# Plan' });
  item('item/completed', { type: 'plan', id: 'plan-empty' });
  delta('plan-delta', 'step', 'item/plan/delta');
  item('item/completed', { type: 'todoList', id: 'todo-1', items: [{ content: 'one', status: 'pending' }, { text: '' }, { step: 'two', completed: true }, { text: 'from text' }, { content: 'default pending' }] });
  item('item/completed', { type: 'todoList', id: 'todo-malformed', items: 'not-an-array' });
  item('item/started', { type: 'spawnAgent', id: 'spawn-1', tool: 'spawnAgent', newThreadId: 'child-1', prompt: 'look', model: 'm' });
  item('item/completed', { type: 'subAgentActivity', id: 'act-1', agentThreadId: 'child-1', kind: 'completed', agentsStates: { 'child-1': { status: 'error', message: 'kept' } } });
  item('item/completed', { type: 'subAgentActivity', id: 'act-2', agentThreadId: 'child-1', kind: 'completed' });
  item('item/started', { type: 'subAgentActivity', id: 'act-3', agentThreadId: 'child-1', kind: 'started' });
  delta('reason-1', 'because', 'item/reasoning/summaryTextDelta');
  item('item/completed', { type: 'agentMessage', id: 'answer-1', text: 'final text', phase: 'final_answer' });
  item('item/completed', { type: 'error', id: 'err-1', message: 'visible' });
  item('item/completed', { type: 'error', id: 'err-empty' });
  item('item/completed', { type: 'webSearch', id: 'web-1', query: 'protocol', status: 'completed' });
  item('item/completed', { type: '', text: 'fallback tool' });
  item('item/completed', { type: 'spawnAgent', newThreadId: 'thread-1', tool: 'spawnAgent' });
  emit({ method: 'turn/plan/updated', params: { threadId: 'thread-1', explanation: 'steps', plan: [{ content: 'ship' }] } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1, cacheWriteInputTokens: 1, reasoningOutputTokens: 1 }, modelContextWindow: 100, last: { totalTokens: 3 } } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { nope: true } } });
  emit({ method: 'turn/plan/updated', params: { threadId: 'thread-1', plan: 'not-an-array' } });
  emit({ method: 'error', params: { threadId: 'thread-1', willRetry: true, error: { message: 'retry' } } });
  emit({ method: 'turn/started', params: { threadId: 'child-1', turn: { id: 'child-turn-2' } } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'child-1', itemId: 'child-msg', delta: 'child ' } });
  emit({ method: 'item/completed', params: { threadId: 'child-1', item: { type: 'agentMessage', id: 'child-msg', text: 'child result' } } });
  emit({ method: 'item/completed', params: { threadId: 'child-1', item: { type: 'fileChange', id: 'child-file', changes: [{ path: 'child.ts', kind: 'add', diff: '@@ -0,0 +1 @@\n+hi\n' }] } } });
  emit({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed', durationMs: 9 } } });
  emit({ method: 'item/completed', params: { threadId: 'unknown-child', item: { type: 'agentMessage', text: 'hidden child' } } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  note(request.method || `id:${request.id}`);
  if (request.method === 'initialize') {
    if (scenario === 'hang-init') return;
    emit({ id: request.id, result: { userAgent: 'fixture' } });
    return;
  }
  if (request.method === 'initialized') return;
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    lastStart = request.params;
    if (scenario === 'no-thread') { emit({ id: request.id, result: {} }); return; }
    if (scenario === 'thread-fallback') {
      emit({ id: request.id, result: { threadId: 'fallback-thread', model: 'reported-model', historyMode: 'paginated' } });
      return;
    }
    const sandbox = scenario === 'external' ? { type: 'externalSandbox' }
      : request.params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
        : request.params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [request.params.cwd, ...(request.params.runtimeWorkspaceRoots || [])], networkAccess: request.params.config?.sandbox_workspace_write?.network_access === true, excludeSlashTmp: false, excludeTmpdirEnvVar: false };
    const thread = { id: 'thread-1', historyMode: scenario === 'legacy' ? '' : 'paginated', model: request.params.model || 'reported-model' };
    const turns = scenario === 'history' ? historyTurns() : scenario === 'history-shape' ? malformedHistoryTurns() : undefined;
    const result = scenario === 'history-root'
      ? { thread: { id: 'thread-1', historyMode: 'paginated' }, turns: historyTurns(), sandbox, approvalPolicy: request.params.approvalPolicy, instructionSources: ['AGENTS.md', 4] }
      : { thread: { ...thread, ...(turns ? { turns } : {}) }, sandbox, approvalPolicy: scenario === 'null-approval' ? null : request.params.approvalPolicy, instructionSources: scenario === 'no-sources' ? 'nope' : ['AGENTS.md'], threadId: 'thread-1' };
    emit({ id: request.id, result });
    return;
  }
  if (request.method === 'thread/turns/list') {
    if (scenario === 'bad-page') { emit({ id: request.id, result: { data: { bad: true } } }); return; }
    if (scenario === 'missing-turn-id') { emit({ id: request.id, result: { data: [{}] } }); return; }
    if (scenario === 'repeat-cursor') { emit({ id: request.id, result: { data: [{ id: 'turn-a' }], nextCursor: 'again' } }); return; }
    if (scenario === 'read-fallback') { emit({ id: request.id, error: { message: 'list failed' } }); return; }
    if (scenario === 'replay-fallback' || scenario === 'history' || scenario === 'history-root' || scenario === 'history-shape') { emit({ id: request.id, result: { data: null } }); return; }
    if (scenario === 'pages') {
      if (!request.params.cursor) emit({ id: request.id, result: { data: [{ id: 'p1', items: [{ type: 'userMessage', id: 'u', text: 'one' }] }], nextCursor: 'page-2' } });
      else emit({ id: request.id, result: { data: [{ id: 'p2', items: [{ type: 'agentMessage', id: 'a', text: 'two', phase: 'final_answer' }] }], nextCursor: '' } });
      return;
    }
    const id = String(request.params.threadId);
    let rows = threads.get(id) ?? [];
    if (hang && id === 'thread-1') rows = [...rows, 'hang-turn'];
    emit({ id: request.id, result: { data: rows.map((turnId) => ({ id: turnId, status: 'completed', items: [] })), nextCursor: null } });
    return;
  }
  if (request.method === 'thread/read') {
    const failed = request.params.threadId === 'child-unknown';
    if (failed) { emit({ id: request.id, error: { message: 'child missing' } }); return; }
    emit({ id: request.id, result: { thread: { status: { type: 'idle' }, turns: [{ id: 'read-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'a', text: 'from read', phase: 'final_answer' }] }] } } });
    return;
  }
  if (request.method === 'thread/list') {
    const body = scenario === 'threads-key'
      ? { threads: [{ thread: { id: 'thread-9', preview: 'Preview' } }, { id: '' }, 'bad'] }
      : { data: [{ id: 'thread-1', title: '', preview: 'Fallback title', updatedAt: '2026-10-17T00:00:00.000Z' }] };
    emit({ id: request.id, result: body });
    return;
  }
  if (request.method === 'thread/fork') {
    if (scenario === 'no-branch') { emit({ id: request.id, result: {} }); return; }
    if (scenario === 'same-branch') { emit({ id: request.id, result: { thread: { id: 'thread-1', historyMode: 'paginated' } } }); return; }
    if (scenario === 'mismatch') { emit({ id: request.id, result: { thread: { id: 'thread-9', historyMode: 'legacy' } } }); return; }
    emit({ id: request.id, result: { thread: { id: 'thread-2', historyMode: 'paginated' } } });
    return;
  }
  if (request.method === 'thread/backgroundTerminals/list') {
    if (lateArmed) {
      lateLists += 1;
      if (lateLists > 1) {
        lateArmed = false;
        item('item/completed', { type: 'agentMessage', id: 'late', text: 'late answer', phase: 'final_answer' });
      }
    }
    if (scenario === 'repeat-cursor') { emit({ id: request.id, result: { data: [{ processId: 'proc-1' }], nextCursor: 'again' } }); return; }
    if (scenario === 'paged-ok') {
      emit({ id: request.id, result: request.params.cursor
        ? { data: [{ processId: 'proc-2', command: 'two' }], nextCursor: '' }
        : { data: [{ processId: 'proc-1', itemId: 'command-1', command: 'one' }], nextCursor: 'page-2' } });
      return;
    }
    if (scenario === 'terminals-key') { emit({ id: request.id, result: { terminals: [{ id: 'proc-2', command: 'listed' }, { command: 'skipped' }] } }); return; }
    if (scenario === 'bad-terminals') { emit({ id: request.id, result: { data: null } }); return; }
    emit({ id: request.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (request.method === 'thread/backgroundTerminals/terminate') { emit({ id: request.id, result: { terminated: true } }); return; }
  if (request.method === 'account/rateLimits/read') {
    emit({ id: request.id, result: scenario === 'rate-empty' ? {} : { rateLimits: { primary: { usedPercent: 7 } } } });
    return;
  }
  if (request.method === 'skills/list') {
    if (scenario === 'skills-fail') { emit({ id: request.id, error: { message: 'skills down' } }); return; }
    emit({ id: request.id, result: { data: [{ skills: [{ name: 'nested' }, { skills: [{ name: 'deep' }] }] }, { name: 'direct' }, { skills: 'nope' }] } });
    return;
  }
  if (request.method === 'mcpServerStatus/list') {
    emit({ id: request.id, result: scenario === 'mcp-bad' ? { data: 'nope' } : { data: [{ name: 'srv' }, { name: 1 }, 'bad'] } });
    return;
  }
  if (request.method === 'thread/compact/start' || request.method === 'turn/steer' || request.method === 'turn/interrupt') {
    emit({ id: request.id, result: {} });
    return;
  }
  if (approvalFollow(request)) return;
  if (request.method === 'review/start') {
    pending = request.id;
    delta('review-1', request.params.target.type);
    complete('review-turn');
    return;
  }
  if (request.method !== 'turn/start') {
    if (request.id !== undefined) emit({ id: request.id, result: {} });
    return;
  }
  pending = request.id;
  const text = String(request.params.input?.[0]?.text || '');
  if (text === 'DISCONNECT') { delta('agent-1', 'partial'); process.exit(1); }
  if (text === 'HANG') {
    hang = true;
    delta('wait', 'waiting');
    emit({ id: request.id, result: { turn: { id: 'hang-turn' } } });
    return;
  }
  if (text === 'ABORT_DURING_REQUEST') return;
  if (text === 'ECHO_POLICY') { delta(`policy-${request.id}`, JSON.stringify({ sandbox: request.params.sandboxPolicy, approval: request.params.approvalPolicy })); complete(`policy-${request.id}`); return; }
  if (text === 'REPORT_START') { delta('start', JSON.stringify(lastStart)); complete('start-turn'); return; }
  if (text === 'REPORT_TURN') { delta('turn-options', JSON.stringify({ model: request.params.model, effort: request.params.effort })); complete('turn-options'); return; }
  if (text === 'EVENTS') { events(); complete('events-turn'); return; }
  if (text === 'FAIL_RETRY') {
    emit({ method: 'error', params: { willRetry: true, error: 'retry', turnId: 'fail-turn' } });
    emit({ method: 'error', params: { error: 'hard failure', turnId: 'fail-turn' } });
    emit({ id: request.id, result: { turn: { id: 'fail-turn' } } });
    pending = undefined;
    return;
  }
  if (text === 'FAIL_EMPTY') { complete('empty-turn', 'failed'); return; }
  if (text === 'INTERRUPTED') { complete('stop-turn', 'interrupted'); return; }
  if (text === 'BARE_COMPLETE') {
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'bare-turn' } } });
    emit({ id: pending, result: { turn: { id: 'bare-turn' } } });
    pending = undefined;
    return;
  }
  if (text === 'FALLBACK_TURN') {
    emit({ method: 'turn/started', params: { threadId: mainThreadId, turn: { id: 'fallback-turn' } } });
    emit({ method: 'turn/completed', params: { threadId: mainThreadId, turn: { status: 'completed' } } });
    emit({ id: request.id, result: { turn: { id: 'fallback-turn' } } });
    pending = undefined;
    return;
  }
  if (text === 'LATE_AFTER') {
    complete('late-turn');
    lateArmed = true;
    lateLists = 0;
    return;
  }
  if (text === 'USAGE_TURN') {
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'usage-turn', status: 'completed' }, usage: { input_tokens: 2, output_tokens: 1, reasoningTokens: 1 } } });
    emit({ id: request.id, result: { turn: { id: 'usage-turn' } } });
    pending = undefined;
    return;
  }
  if (text === 'USAGE_PARTIAL') {
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 'bad', outputTokens: 3 }, modelContextWindow: 'bad', last: { totalTokens: 'bad' } } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { inputTokens: 4, outputTokens: 'bad' } } });
    complete('partial-usage-turn');
    return;
  }
  if (text === 'APPROVALS') {
    emit({ id: 50, method: 'item/commandExecution/requestApproval', params: { approvalId: 'a1', command: 'npm test', reason: 'because' } });
    return;
  }
  if (text === 'QUESTIONS') {
    emit({ id: 60, method: 'item/tool/requestUserInput', params: { itemId: 'q', questions: [
      { id: 'q1', question: 'Pick', options: [{ label: 'Yes' }, { label: '' }, 'bad'] },
      { id: '', question: 'skip' },
      { id: 'q2', header: 'Title only' },
      { question: 'missing' },
    ] } });
    return;
  }
  if (text === 'IMAGE') { delta('image', JSON.stringify(request.params.input.map((block) => block.type))); complete('image-turn'); return; }
  delta('agent-1', 'ok');
  complete('plain-turn');
});

const approvals = [];
function approvalFollow(request) {
  if (request.method || request.id === undefined) return false;
  if (![50, 51, 52, 53, 60].includes(request.id)) return false;
  approvals.push(request.result);
  if (request.id === 50) { emit({ id: 51, method: 'item/fileChange/requestApproval', params: { itemId: 'file', reason: 'edit file' } }); return true; }
  if (request.id === 51) { emit({ id: 52, method: 'item/permissions/requestApproval', params: { approvalId: 'net' } }); return true; }
  if (request.id === 52) { emit({ id: 53, method: 'item/unknown/request', params: {} }); return true; }
  if (request.id === 53) { delta('approvals', JSON.stringify(approvals)); complete('approval-turn'); return true; }
  delta('answers', JSON.stringify(request.result));
  complete('question-turn');
  return true;
}
