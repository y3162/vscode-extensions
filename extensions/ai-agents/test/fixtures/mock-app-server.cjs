#!/usr/bin/env node
const synthetic = require('./synthetic-runtime.cjs');
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const replay = (events) => {
  for (const row of events) {
    if (row.item) emit({ method: row.method, params: { threadId: 'thread-1', item: row.item } });
    else emit({ method: row.method, params: row.params });
  }
};
const fs = require('node:fs');
const path = require('node:path');
let pendingTurn;
let activeTerminals = [];
let failLists = false;
let failTerminate = false;
let listCount = 0;
let policyTurn = 0;
let replayFinal = false;
let nextBranchNumber = 2;
let runCount = 0;
let historyFile = '';
let threadTurnIds = new Map([['thread-1', ['turn-a', 'turn-b']]]);
const loadHistory = (cwd) => {
  const gitDirectory = path.join(cwd, '.git');
  historyFile = fs.existsSync(gitDirectory) ? path.join(gitDirectory, 'ai-agents-mock-app-server.json') : '';
  try {
    const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    nextBranchNumber = Number.isInteger(saved.nextBranchNumber) ? saved.nextBranchNumber : 2;
    threadTurnIds = new Map(Object.entries(saved.threads || {}));
  } catch {
    nextBranchNumber = 2;
    threadTurnIds = new Map([['thread-1', ['turn-a', 'turn-b']]]);
  }
};
const saveHistory = () => {
  if (!historyFile) return;
  fs.writeFileSync(historyFile, JSON.stringify({ nextBranchNumber, threads: Object.fromEntries(threadTurnIds) }));
};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'fixture', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    const cwd = typeof request.params.cwd === 'string' ? request.params.cwd : process.cwd();
    if (historyFile !== path.join(cwd, '.git', 'ai-agents-mock-app-server.json')) loadHistory(cwd);
    replayFinal = request.params.threadId === 'history-final';
    const requestedThreadId = typeof request.params.threadId === 'string' ? request.params.threadId : '';
    const responseThreadId = request.method === 'thread/resume' && (/^thread-\d+$/.test(requestedThreadId) || requestedThreadId === 'thread-restore-child') ? requestedThreadId : 'thread-1';
    if (!threadTurnIds.has(responseThreadId)) threadTurnIds.set(responseThreadId, []);
    saveHistory();
    const sandbox = request.params.sandbox === 'read-only' ? {type:'readOnly',networkAccess:false}
      : request.params.sandbox === 'danger-full-access' ? {type:'dangerFullAccess'}
        : {type:'workspaceWrite', writableRoots:[request.params.cwd,...(request.params.runtimeWorkspaceRoots || [])],networkAccess:request.params.config?.sandbox_workspace_write?.network_access === true,excludeSlashTmp:true,excludeTmpdirEnvVar:true};
    emit({ id: request.id, result: { thread: { id: responseThreadId, title: 'Fixture', historyMode: 'paginated' }, sandbox, approvalPolicy:request.params.approvalPolicy, instructionSources: ['AGENTS.md'], threadId: responseThreadId } });
  } else if (request.method === 'thread/list') {
    emit({ id: request.id, result: { data: [{ id: 'thread-1', title: 'Fixture', updatedAt: '2026-10-16T00:00:00.000Z' }] } });
  } else if (request.method === 'turn/start') {
    pendingTurn = request.id;
    const text = String(request.params.input?.[0]?.text || '');
    const activeThreadId = String(request.params.threadId || 'thread-1');
    const fs = require('node:fs');
    const writeMatch = /^write (.+) into a\.txt$/.exec(text);
    if (text === 'touch a.txt') fs.writeFileSync('a.txt', '');
    else if (writeMatch) fs.writeFileSync('a.txt', writeMatch[1]);
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
    if (text === 'PARALLEL_CHILDREN' || text === 'DUPLICATE_CHILD' || text === 'REORDERED_CHILD' || text === 'USAGE_TOTAL') {
      const events = text === 'PARALLEL_CHILDREN' ? synthetic.parallelChildren()
        : text === 'DUPLICATE_CHILD' ? synthetic.duplicateChild()
          : text === 'REORDERED_CHILD' ? synthetic.reorderedChild()
            : synthetic.usageSnapshots();
      replay(events);
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'synthetic-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'synthetic-turn' } } });
      pendingTurn = undefined;
      return;
    }
    if (text === 'SUBAGENT_GUI_STAGED') {
      const parentTurnId = 'gui-parent-turn';
      const children = [
        { id: 'gui-child-a', name: '/root/worker-alpha', task: 'Inspect the first independent feature and report its current execution state for the visual acceptance run.' },
        { id: 'gui-child-b', name: '/root/worker-beta', task: 'Inspect the second independent feature and report its current execution state for the visual acceptance run.' },
      ];
      emit({ method: 'turn/started', params: { threadId: activeThreadId, turn: { id: parentTurnId, status: 'inProgress', items: [] } } });
      for (const child of children) {
        const started = { type: 'subAgentActivity', id: `start-${child.id}`, kind: 'started', agentThreadId: child.id, agentPath: child.name, prompt: child.task, model: 'gpt-6-luna' };
        emit({ method: 'item/started', params: { threadId: activeThreadId, item: started } });
        emit({ method: 'item/completed', params: { threadId: activeThreadId, item: started } });
        emit({ method: 'item/started', params: { threadId: child.id, item: { type: 'commandExecution', id: `exec-${child.id}`, command: 'inspect independent task', status: 'inProgress' } } });
        emit({ method: 'item/commandExecution/outputDelta', params: { threadId: child.id, itemId: `exec-${child.id}`, delta: `${child.name} is still running\n` } });
      }
      const wait = { type: 'collabAgentToolCall', id: 'wait-gui-parent', tool: 'wait', status: 'inProgress', senderThreadId: activeThreadId, receiverThreadIds: children.map((child) => child.id), agentsStates: Object.fromEntries(children.map((child) => [child.id, { status: 'running' }])) };
      emit({ method: 'item/started', params: { threadId: activeThreadId, item: wait } });

      const completed = new Set();
      const finishChild = (child) => {
        if (completed.has(child.id)) return;
        completed.add(child.id);
        emit({ method: 'item/completed', params: { threadId: child.id, item: { type: 'commandExecution', id: `exec-${child.id}`, command: 'inspect independent task', status: 'completed', aggregatedOutput: `${child.name} finished\n`, exitCode: 0 } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: child.id, itemId: `answer-${child.id}`, delta: `${child.name} completed` } });
        emit({ method: 'item/completed', params: { threadId: child.id, item: { type: 'agentMessage', id: `answer-${child.id}`, text: `${child.name} completed`, phase: 'final_answer' } } });
        emit({ method: 'turn/completed', params: { threadId: child.id, turn: { id: `turn-${child.id}`, status: 'completed' } } });
        emit({ method: 'item/completed', params: { threadId: activeThreadId, item: { type: 'subAgentActivity', id: `done-${child.id}`, kind: 'completed', agentThreadId: child.id, agentPath: child.name, model: null } } });
      };
      const gate = setInterval(() => {
        for (const child of children) {
          if (!completed.has(child.id) && fs.existsSync(path.join(process.cwd(), `${child.id}.done`))) finishChild(child);
        }
        if (completed.size !== children.length) return;
        clearInterval(gate);
        emit({ method: 'item/completed', params: { threadId: activeThreadId, item: { ...wait, status: 'completed' } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, itemId: 'answer-gui-parent', delta: 'Both independent acceptance tasks completed.' } });
        emit({ method: 'item/completed', params: { threadId: activeThreadId, item: { type: 'agentMessage', id: 'answer-gui-parent', text: 'Both independent acceptance tasks completed.', phase: 'final_answer' } } });
        emit({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: parentTurnId, status: 'completed' } } });
        emit({ id: request.id, result: { turn: { id: parentTurnId, status: 'completed' } } });
        pendingTurn = undefined;
      }, 50);
      return;
    }
    if (text === 'DELAYED_CHILD') {
      const delayed = synthetic.delayedChild();
      replay(delayed.immediate);
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'delayed-turn', status: 'completed' } } });
      emit({ id: request.id, result: { turn: { id: 'delayed-turn' } } });
      pendingTurn = undefined;
      setTimeout(() => replay(delayed.late), 40);
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
    if (text === 'NATIVE_MOVE') {
      const fs = require('node:fs');
      fs.renameSync('a.txt', 'b.txt'); fs.writeFileSync('b.txt', 'beta\n');
      replay(synthetic.nativeMove(process.cwd()));
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
    const backendTurnId = `run-${++runCount}`;
    const threadTurns = threadTurnIds.get(activeThreadId) ?? [];
    threadTurns.push(backendTurnId);
    threadTurnIds.set(activeThreadId, threadTurns);
    saveHistory();
    emit({ method: 'turn/started', params: { threadId: activeThreadId, turn: { id: backendTurnId, status: 'inProgress', items: [] } } });
    emit({ method: 'item/agentMessage/delta', params: { itemId: streamId, delta: text === 'SECURITY_POLICY' ? JSON.stringify({sandbox:request.params.sandboxPolicy,approval:request.params.approvalPolicy}) : 'app ' } });
    emit({ method: 'item/agentMessage/delta', params: { itemId: streamId, delta: text === 'SECURITY_POLICY' ? '' : 'server' } });
    emit({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: backendTurnId, status: 'completed', items: [] } } });
    emit({ id: request.id, result: { turn: { id: backendTurnId, status: 'completed' } } });
    pendingTurn = undefined;
  } else if (request.method === 'thread/turns/list') {
    const requestedThreadId = String(request.params.threadId || '');
    const restoredChildParent = requestedThreadId === 'thread-restore-child' ? [{ id: 'parent-turn', status: 'completed', items: [
      { id: 'spawn-child', type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'inspect restored child', model: 'gpt-test', receiverThreadIds: ['child-thread'], agentsStates: { 'child-thread': { status: 'completed', message: 'restored child answer' } } },
    ] }] : undefined;
    const childHistory = requestedThreadId === 'child-thread' ? [{ id: 'child-history-turn', status: 'completed', items: [
      { id: 'child-command', type: 'commandExecution', command: 'printf child', aggregatedOutput: 'restored child output\n', status: 'completed', exitCode: 0 },
      { id: 'child-answer', type: 'agentMessage', text: 'Restored child result', phase: 'final_answer' },
    ] }] : undefined;
    const data = replayFinal
      ? [{ id: 'saved-turn', status: 'completed', items: [
        { id: 'commentary', type: 'agentMessage', text: 'Checking files', phase: 'commentary' },
        { id: 'answer', type: 'agentMessage', text: 'Backend final answer', phase: 'final_answer' },
      ] }]
      : childHistory ?? restoredChildParent ?? (threadTurnIds.get(requestedThreadId) ?? []).map((id) => ({ id, status: 'completed', items: [] }));
    emit({ id: request.id, result: { data, nextCursor: null } });
  } else if (request.method === 'thread/read' && request.params.threadId === 'silent-child') {
    emit({ id: request.id, result: { thread: { status: { type: 'notLoaded' }, turns: [{ id: 'silent-child-turn', status: 'interrupted', items: [] }] } } });
  } else if (request.method === 'thread/backgroundTerminals/list') {
    listCount++;
    if (failLists && listCount > 1) emit({ id: request.id, error: { message: 'terminal list unavailable' } });
    else emit({ id: request.id, result: { data: request.params.cursor ? activeTerminals.slice(1) : activeTerminals.slice(0, 1), nextCursor: !request.params.cursor && activeTerminals.length > 1 ? 'next' : null } });
  } else if (request.method === 'thread/backgroundTerminals/terminate') {
    if (!failTerminate) activeTerminals = activeTerminals.filter((item) => item.processId !== request.params.processId);
    emit({ id: request.id, result: { terminated: !failTerminate } });
  } else if (request.method === 'turn/interrupt') {
    emit({ id: request.id, result: {} });
  }
  else if (request.id === 50 || (pendingTurn && request.result)) {
    emit({ method: 'item/completed', params: { item: { id: 'agent-1', type: 'agentMessage', text: `approved:${request.result?.decision}` } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    emit({ id: pendingTurn, result: { turn: { id: 'turn-1', status: 'completed' } } });
    pendingTurn = undefined;
  } else if (request.method === 'thread/fork') {
    const sourceTurns = threadTurnIds.get(String(request.params.threadId)) ?? [];
    const boundary = sourceTurns.indexOf(request.params.beforeTurnId);
    const branchId = `thread-${nextBranchNumber++}`;
    threadTurnIds.set(branchId, boundary >= 0 ? sourceTurns.slice(0, boundary) : [...sourceTurns]);
    saveHistory();
    emit({ id: request.id, result: { thread: { id: branchId, historyMode: 'paginated' } } });
  }
  else if (request.method === 'thread/compact/start') emit({ id: request.id, result: {} });
  else if (request.method === 'account/rateLimits/read') emit({ id: request.id, result: { rateLimits: { primary: { usedPercent: 12 } } } });
  else if (request.method === 'skills/list') emit({ id: request.id, result: { data: [{ cwd: '/tmp', skills: [{ name: 'fixture-skill' }], errors: [] }] } });
  else if (request.method === 'mcpServerStatus/list') emit({ id: request.id, result: { data: [{ name: 'fixture-mcp' }] } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
