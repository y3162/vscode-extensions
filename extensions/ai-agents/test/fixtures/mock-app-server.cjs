#!/usr/bin/env node
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pendingTurn;
let activeTerminals = [];
let failLists = false;
let failTerminate = false;
let listCount = 0;
let policyTurn = 0;
let replayFinal = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'fixture', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    replayFinal = request.params.threadId === 'history-final';
    const sandbox = request.params.sandbox === 'read-only' ? {type:'readOnly',networkAccess:false}
      : request.params.sandbox === 'danger-full-access' ? {type:'dangerFullAccess'}
        : {type:'workspaceWrite', writableRoots:[request.params.cwd,...(request.params.runtimeWorkspaceRoots || [])],networkAccess:request.params.config?.sandbox_workspace_write?.network_access === true,excludeSlashTmp:true,excludeTmpdirEnvVar:true};
    emit({ id: request.id, result: { thread: { id: 'thread-1', title: 'Fixture' }, sandbox, approvalPolicy:request.params.approvalPolicy, instructionSources: ['AGENTS.md'], threadId: 'thread-1' } });
  } else if (request.method === 'thread/list') {
    emit({ id: request.id, result: { data: [{ id: 'thread-1', title: 'Fixture', updatedAt: '2026-10-16T00:00:00.000Z' }] } });
  } else if (request.method === 'turn/start') {
    pendingTurn = request.id;
    const text = String(request.params.input?.[0]?.text || '');
    if (text === 'EARLY_TERMINAL_OUTPUT') {
      emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'commandExecution', id: 'early-command', command: 'python3 -u script.py', status: 'inProgress' } } });
      emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', itemId: 'early-command', delta: 'EARLY_READY\n' } });
      activeTerminals = [{ itemId: 'early-command', processId: 'early-process', command: 'python3 -u script.py' }];
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'early-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'early-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (text === 'EXIT_AFTER_START') {
      emit({ id: request.id, result: { turn: { id: 'crash-turn' } } });
      setTimeout(() => process.exit(1), 20);
      return;
    }
    if (text === 'REAL_SUBAGENTS') {
      const captured = require('./runtime-090.json');
      for (const row of captured.appServer) {
        const params = structuredClone(row.params);
        if (params.threadId === captured.provenance.parentThreadId) params.threadId = 'thread-1';
        emit({ method: row.method, params });
      }
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'real-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'real-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (text === 'CHILD_FAILURES') {
      const notify = (method, item) => emit({ method, params: { threadId: 'thread-1', item } });
      for (const agentThreadId of ['child-error', 'child-cancelled']) notify('item/started', { type: 'subAgentActivity', id: `start-${agentThreadId}`, agentThreadId, agentPath: `/root/${agentThreadId}`, kind: 'started' });
      notify('item/completed', { type: 'collabAgentToolCall', id: 'spawn-call', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child-error'], agentsStates: { 'child-error': { status: 'running' } } });
      emit({ method: 'turn/completed', params: { threadId: 'child-error', turn: { id: 'a', status: 'failed', error: { message: 'child failed' } } } });
      emit({ method: 'turn/completed', params: { threadId: 'child-cancelled', turn: { id: 'b', status: 'interrupted' } } });
      notify('item/completed', { type: 'subAgentActivity', id: 'end-error', agentThreadId: 'child-error', agentPath: '/root/child-error', kind: 'completed' });
      notify('item/started', { type: 'subAgentActivity', id: 'unknown', agentThreadId: 'child-unknown', agentPath: '/root/unknown', kind: 'interacted' });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'failures-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'failures-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (text === 'SILENT_CHILD') {
      emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'subAgentActivity', id: 'silent-start', agentThreadId: 'silent-child', agentPath: '/root/silent', kind: 'started' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'silent-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'silent-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (text === 'REAL_RENAME') {
      const fs = require('node:fs');
      const captured = require('./runtime-090.json');
      fs.renameSync('a.txt', 'b.txt'); fs.writeFileSync('b.txt', 'beta\n');
      for (const row of captured.rename) {
        const item = JSON.parse(JSON.stringify(row.item).replaceAll('/verification/rename', process.cwd()));
        emit({ method: row.method, params: { threadId: 'thread-1', item } });
      }
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'rename-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'rename-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (/^(BACKGROUND|POLL_EXIT|LIST_FAIL|TERMINATE_FAIL|PAGED)$/.test(text)) {
      failLists = text === 'LIST_FAIL'; failTerminate = text === 'TERMINATE_FAIL'; listCount = 0;
      activeTerminals = [{ processId: 'proc-1', itemId: 'command-1', command: 'finite-process' }];
      if (text === 'PAGED') activeTerminals.push({ processId: 'proc-2', itemId: 'command-2', command: 'second-process' });
      emit({ method: 'item/started', params: { threadId: 'thread-1', item: { type: 'commandExecution', id: 'command-1', processId: 'proc-1', command: 'finite-process', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'background-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'background-turn' } } });
      pendingTurn = undefined;
      if (text === 'BACKGROUND' || text === 'POLL_EXIT') setTimeout(() => {
        activeTerminals = [];
        if (text === 'BACKGROUND') emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', id: 'command-1', processId: 'proc-1', command: 'finite-process', status: 'completed', aggregatedOutput: 'stdout done\nstderr done', exitCode: 0 } } });
      }, 150);
      return;
    }
    if (text.includes('KILL_PROCESS')) process.exit(1);
    if (text.includes('FAIL_TURN')) {
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [], error: { message: 'boom' } } } });
      emit({ id: request.id, result: { turn: { id: 'turn-1', status: 'failed' } } });
      pendingTurn = undefined;
      return;
    }
    if (text.includes('SPAWN_AGENT')) {
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'spawn-1', type: 'spawn_agent', prompt: 'read the tree', status: 'in_progress', newThreadId: 'child-thread' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'child-thread', itemId: 'child-msg', delta: 'child result' } });
      emit({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-spawn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'turn-spawn', status: 'completed' } } });
      pendingTurn = undefined;
      return;
    }
    if (text.includes('NEED_APPROVAL')) {
      emit({ id: 50, method: 'item/commandExecution/requestApproval', params: { approvalId: 'approval-1', command: 'npm test', reason: 'fixture command' } });
      return;
    }
    const streamId = text === 'SECURITY_POLICY' ? `policy-${++policyTurn}` : 'agent-1';
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    emit({ method: 'item/agentMessage/delta', params: { itemId: streamId, delta: text === 'SECURITY_POLICY' ? JSON.stringify({sandbox:request.params.sandboxPolicy,approval:request.params.approvalPolicy}) : 'app ' } });
    emit({ method: 'item/agentMessage/delta', params: { itemId: streamId, delta: text === 'SECURITY_POLICY' ? '' : 'server' } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    emit({ id: request.id, result: { turn: { id: 'turn-1', status: 'completed' } } });
    pendingTurn = undefined;
  } else if (request.method === 'thread/turns/list' && replayFinal) {
    emit({ id: request.id, result: { data: [{ id: 'saved-turn', status: 'completed', items: [
      { id: 'commentary', type: 'agentMessage', text: 'Checking files', phase: 'commentary' },
      { id: 'answer', type: 'agentMessage', text: 'Backend final answer', phase: 'final_answer' },
    ] }], nextCursor: null } });
  } else if (request.method === 'thread/read' && request.params.threadId === 'silent-child') {
    emit({ id: request.id, result: { thread: { status: { type: 'notLoaded' }, turns: [{ id: 'silent-child-turn', status: 'interrupted', items: [] }] } } });
  } else if (request.method === 'thread/backgroundTerminals/list') {
    listCount++;
    if (failLists && listCount > 1) emit({ id: request.id, error: { message: 'terminal list unavailable' } });
    else emit({ id: request.id, result: { data: request.params.cursor ? activeTerminals.slice(1) : activeTerminals.slice(0, 1), nextCursor: !request.params.cursor && activeTerminals.length > 1 ? 'next' : null } });
  } else if (request.method === 'thread/backgroundTerminals/terminate') {
    if (!failTerminate) activeTerminals = activeTerminals.filter((item) => item.processId !== request.params.processId);
    emit({ id: request.id, result: { terminated: !failTerminate } });
  } else if (request.method === 'turn/interrupt') emit({ id: request.id, result: {} });
  else if (request.id === 50 || (pendingTurn && request.result)) {
    emit({ method: 'item/completed', params: { item: { id: 'agent-1', type: 'agentMessage', text: `approved:${request.result?.decision}` } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    emit({ id: pendingTurn, result: { turn: { id: 'turn-1', status: 'completed' } } });
    pendingTurn = undefined;
  } else if (request.method === 'thread/fork') emit({ id: request.id, result: { thread: { id: 'thread-2' } } });
  else if (request.method === 'thread/compact/start') emit({ id: request.id, result: {} });
  else if (request.method === 'account/rateLimits/read') emit({ id: request.id, result: { rateLimits: { primary: { usedPercent: 12 } } } });
  else if (request.method === 'skills/list') emit({ id: request.id, result: { data: [{ cwd: '/tmp', skills: [{ name: 'fixture-skill' }], errors: [] }] } });
  else if (request.method === 'mcpServerStatus/list') emit({ id: request.id, result: { data: [{ name: 'fixture-mcp' }] } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
