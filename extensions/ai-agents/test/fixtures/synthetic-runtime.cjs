// Synthetic protocol events. These reproduce observed App Server and ACP
// message shapes (including duplicate start notifications, wait calls, and
// native move_path). They are not a captured session, account, or transcript.
const model = 'gpt-6-luna';
const parent = 'thread-1';

const children = [
  { id: 'child-alpha', name: '/root/alpha', preview: 'alpha result' },
  { id: 'child-beta', name: '/root/beta', preview: 'beta result' },
];

function parentItem(method, item) {
  return { method, params: { threadId: parent, turnId: 'parent-turn', item } };
}

function childMessage(threadId, method, extra) {
  return { method, params: { threadId, turnId: `turn-${threadId}`, ...extra } };
}

function parallelChildren() {
  const events = [];
  for (const child of children) {
    const started = {
      type: 'subAgentActivity', id: `start-${child.id}`, kind: 'started',
      agentThreadId: child.id, agentPath: child.name, model, reasoningEffort: 'low',
    };
    // item/completed of a start item is not the child finishing.
    events.push(parentItem('item/started', started));
    events.push(parentItem('item/completed', started));
  }
  for (const child of children) {
    const wait = {
      type: 'collabAgentToolCall', id: `wait-${child.id}`, tool: 'wait', status: 'inProgress',
      senderThreadId: parent, receiverThreadIds: [], agentsStates: {},
    };
    events.push(parentItem('item/started', wait));
    events.push(parentItem('item/completed', { ...wait, status: 'completed' }));
  }
  for (const child of children) {
    events.push(childMessage(child.id, 'item/completed', {
      item: {
        type: 'commandExecution', id: `exec-${child.id}`, command: 'printf', status: 'completed',
        processId: `proc-${child.id}`, aggregatedOutput: `${child.preview}\n`, exitCode: 0,
      },
    }));
    events.push(childMessage(child.id, 'item/agentMessage/delta', { itemId: `msg-${child.id}`, delta: child.preview.slice(0, 5) }));
    events.push(childMessage(child.id, 'item/agentMessage/delta', { itemId: `msg-${child.id}`, delta: child.preview.slice(5) }));
    events.push(childMessage(child.id, 'item/completed', {
      item: { type: 'agentMessage', id: `msg-${child.id}`, text: child.preview, phase: 'final_answer' },
    }));
    events.push(childMessage(child.id, 'turn/completed', { turn: { id: `turn-${child.id}`, status: 'completed' } }));
    const done = {
      type: 'subAgentActivity', id: `done-${child.id}`, kind: 'completed',
      agentThreadId: child.id, agentPath: child.name, model: null,
    };
    events.push(parentItem('item/started', done));
    events.push(parentItem('item/completed', done));
  }
  return events;
}

function duplicateChild() {
  const started = {
    type: 'subAgentActivity', id: 'start-dup', kind: 'started',
    agentThreadId: 'child-dup', agentPath: '/root/dup', model,
  };
  const done = { ...started, id: 'done-dup', kind: 'completed' };
  return [
    parentItem('item/started', started),
    parentItem('item/completed', started),
    parentItem('item/started', started),
    parentItem('item/completed', done),
  ];
}

function reorderedChild() {
  const done = {
    type: 'subAgentActivity', id: 'done-reorder', kind: 'completed',
    agentThreadId: 'child-reorder', agentPath: '/root/reorder', model,
  };
  const started = { ...done, id: 'start-reorder', kind: 'started' };
  return [parentItem('item/completed', done), parentItem('item/started', started)];
}

function delayedChild() {
  const started = {
    type: 'subAgentActivity', id: 'start-late', kind: 'started',
    agentThreadId: 'child-late', agentPath: '/root/late', model,
  };
  return {
    immediate: [parentItem('item/started', started), parentItem('item/completed', started)],
    late: [childMessage('child-late', 'turn/completed', { turn: { id: 'late-turn', status: 'completed' } })],
  };
}

function usageSnapshots() {
  const total = (inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens) => ({
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { total: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens, cacheWriteInputTokens } } },
  });
  return [total(20, 5, 8, 4), total(10, 1, 2, 1)];
}

function acpTasks() {
  const tasks = [
    { toolCallId: 'tool-alpha', description: 'alpha', agentId: 'agent-alpha', durationMs: 17834 },
    { toolCallId: 'tool-beta', description: 'beta', agentId: 'agent-beta', durationMs: 17036 },
  ];
  const events = [];
  for (const task of tasks) {
    events.push({
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: task.toolCallId, title: 'Task: Subagent task', kind: 'other', status: 'pending', rawInput: { _toolName: 'task' } } },
    });
  }
  for (const task of tasks) {
    events.push({
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed', rawOutput: { durationMs: task.durationMs, isBackground: false, result: `${task.description} child output` } } },
    });
    events.push({
      method: 'request',
      params: {
        method: 'cursor/task',
        params: {
          toolCallId: task.toolCallId, description: task.description, prompt: 'Return the child result only.',
          subagentType: { custom: { unspecified: {} } }, model: 'composer-2.5-fast', agentId: task.agentId, durationMs: task.durationMs,
        },
      },
    });
  }
  // Exercise the adapter's out-of-order defense: an older progress notification
  // must not resurrect alpha after its completed tool result was already emitted.
  events.push({ method: 'request', params: { method: 'cursor/task', params: { toolCallId: 'tool-alpha', description: 'alpha', status: 'running' } } });
  return events;
}

function acpChildOutcomes() {
  return [
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-failed', title: 'Task: failed child', kind: 'other', status: 'pending', rawInput: { _toolName: 'task' } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-cancelled', title: 'Task: cancelled child', kind: 'other', status: 'pending', rawInput: { _toolName: 'task' } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-failed', status: 'failed', rawOutput: { isBackground: false } } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-cancelled', status: 'cancelled', rawOutput: { isBackground: false } } } },
  ];
}

function nativeMove(cwd) {
  const source = `${cwd}/a.txt`;
  const destination = `${cwd}/b.txt`;
  const change = {
    path: source,
    kind: { type: 'update', move_path: destination },
    diff: `@@ -1 +1 @@\n-alpha\n+beta\n\n\nMoved to: ${destination}`,
  };
  const item = (status) => ({ type: 'fileChange', id: 'move-1', status, changes: [change] });
  return [
    { method: 'item/started', item: item('inProgress') },
    { method: 'item/completed', item: item('completed') },
  ];
}

module.exports = {
  model, children, parallelChildren, duplicateChild, reorderedChild, delayedChild,
  usageSnapshots, acpTasks, acpChildOutcomes, nativeMove,
};
