#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = process.env.ACP_EDGE || '';
const counter = process.env.EDGE_COUNTER || '';
let sessionId = 'acp-edge';
let pending;
let mode = 'agent';
let modelSets = 0;
const decisions = [];
const fallbackDecisions = [];

const note = (method) => { if (counter) fs.appendFileSync(counter, `${method}\n`); };
const textOf = (prompt) => JSON.stringify(prompt ?? '');
const agent = (text) => emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const finish = (stopReason = 'end_turn') => { emit({ id: pending, result: { stopReason } }); pending = undefined; };

function replayHistory() {
  const update = (sessionUpdate, extra) => emit({ method: 'session/update', params: { update: { sessionUpdate, ...extra } } });
  update('user_message', { content: [{ type: 'text', text: 'q1' }] });
  update('user_message_chunk', { content: { type: 'text', text: ' more' } });
  update('agent_message', { content: { text: 'full answer' } });
  update('plan', { content: { text: '   ' } });
  update('plan', { content: [{ type: 'text', text: 'saved plan' }] });
  update('current_mode_update', {});
  update('agent_thought_chunk', { content: {} });
  update('agent_thought_chunk', { content: { text: 'thinking' } });
  update('tool_call', { toolCallId: 'read-1', title: 'Read README.md L1-3', kind: 'read', status: 'completed', rawInput: { path: 'README.md', line: 1, endLine: 3 }, content: [{ type: 'text', text: 'file body' }] });
  update('tool_call_update', { toolCallId: 'read-1', title: 'Read README.md L1-3', kind: 'read', status: 'completed', rawInput: { path: 'README.md', line: 1, endLine: 3 }, content: ' more output' });
  emit({ method: 'cursor/update_todos', params: { toolCallId: 'todo-1', todos: [{ content: 'one', status: 'pending' }, { text: '' }] } });
  emit({ method: 'cursor/update_todos', params: { todos: [] } });
  emit({ method: 'cursor/generate_image', params: { filePath: 'out.png' } });
  emit({ method: 'cursor/generate_image', params: {} });
  emit({ method: 'cursor/task', params: {} });
  update('unknown_kind', {});
  update('cursor/update_todos', { todos: [{ content: 'inline', status: 'completed' }] });
  emit({ method: 'session/update', params: { sessionUpdate: 'agent_message', content: { text: 'direct update payload' } } });
}

function shapes() {
  const update = (sessionUpdate, extra) => emit({ method: 'session/update', params: { update: { sessionUpdate, ...extra } } });
  update('user_message_chunk', { content: { text: 'ignored while live' } });
  update('agent_thought_chunk', { content: [{ text: 'one' }, { stdout: 'two', stderr: 'three' }] });
  update('plan', { content: '   ' });
  update('tool_call_update', {
    toolCallId: 'edit-1', title: 'Edit src/a.ts', kind: 'edit', status: 'completed', rawInput: { file_path: 'src/a.ts' },
    content: [
      { type: 'text' },
      { type: 'diff', path: '', oldText: 'a', newText: 'b' },
      { type: 'diff', path: 'src/a.ts', oldText: null, newText: 'new\n' },
      { content: { type: 'diff', path: 'src/b.ts', oldText: 'old', newText: 'new' } },
      { type: 'diff', path: 'src/c.ts', kind: 'delete' },
    ],
  });
  update('tool_call', { toolCallId: 'move-1', title: 'Move src/d.ts', kind: 'move', status: 'in_progress', content: [{ type: 'diff', path: 'src/d.ts', oldText: 'from', newText: 'to' }] });
  update('tool_call', { title: 'Task: missing', kind: 'other', status: 'pending', rawInput: { _toolName: 'task' } });
  update('tool_call', { toolCallId: 'task-1', title: 'Task: named', kind: 'other', status: 'pending', rawInput: { _toolName: 'task', description: 'named' } });
  emit({ method: 'cursor/task', params: { toolCallId: 'task-1', description: 'named', subagentType: 'explore', isBackground: true, prompt: 'look', model: 'composer', agentId: 'agent-1', status: 'running' } });
  emit({ method: 'cursor/task', params: { toolCallId: 'task-1', subagentType: { custom: 'custom-agent' }, status: 'completed', durationMs: 4 } });
  emit({ method: 'cursor/task', params: { toolCallId: 'task-1', status: 'unrecognized-status' } });
  emit({ method: 'cursor/task', params: { toolCallId: 'task-2', description: 'second', subagentType: { custom: 1 }, status: 'failed', isBackground: false } });
  emit({ method: 'cursor/task', params: { toolCallId: 'task-3', description: 'third', status: 'mystery' } });
  update('tool_call', { toolCallId: 'shell-1', title: 'npm test', kind: 'execute', status: 'completed', rawOutput: { stdout: 'ok' } });
  update('tool_call', { toolCallId: 'generic-1', kind: 'other', rawOutput: { text: 'generic output' } });
  update('tool_call', { toolCallId: 'delete-1', title: 'Delete old.ts', kind: 'delete', status: 'completed', content: [{ type: 'diff', path: 'old.ts', oldText: 'gone\n' }] });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  note(request.method || `id:${request.id}`);
  if (request.method === 'initialize') {
    if (scenario === 'hang-init') return;
    emit({ id: request.id, result: { protocolVersion: 1 } });
    return;
  }
  if (request.method === 'authenticate') {
    if (scenario === 'hang-auth') return;
    if (scenario === 'auth-other') { emit({ id: request.id, error: { message: 'temporary unavailable' } }); return; }
    if (scenario === 'auth-login') { emit({ id: request.id, error: { message: 'login required' } }); return; }
    emit({ id: request.id, result: {} });
    return;
  }
  if (request.method === 'session/new' || request.method === 'session/load') {
    sessionId = request.params.sessionId || 'acp-edge';
    if (scenario === 'no-session') { emit({ id: request.id, result: {} }); return; }
    if (scenario === 'config-models') {
      emit({ id: request.id, result: { sessionId, configOptions: [
        { id: 'mode', currentValue: 'agent' },
        { id: 'model', currentValue: 'plain', options: [
          { value: 'composer-2.5[fast=true]', name: 'Composer' }, { value: 'auto[context=1]', name: 'Auto' },
          { value: 'plain', name: 'Plain' }, { name: 'skip' }, { value: 3 },
        ] },
      ] } });
      return;
    }
    const current = scenario === 'same-model' ? 'composer-2.5[fast=true]' : scenario === 'switch-auto' ? 'plain' : 'default[]';
    if (scenario === 'replay') replayHistory();
    emit({ id: request.id, result: { sessionId, models: { currentModelId: current, availableModels: [
      { modelId: 'default[]', name: 'Auto' }, { modelId: 'auto[context=1]', name: 'Auto Variant' },
      { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }, { modelId: 'plain', name: 'Plain' }, { modelId: 'no-ack[]', name: 'no-ack' },
    ] } } });
    return;
  }
  if (request.method === 'session/list') {
    emit({ id: request.id, result: scenario === 'list-empty' ? {} : { sessions: [
      { sessionId: 's1', title: 'Named', updatedAt: '2026-01-01T00:00:00.000Z' }, { sessionId: 's2', title: '', updatedAt: 5 }, { title: 'missing' }, 'bad',
    ] } });
    return;
  }
  if (request.method === 'session/set_mode') {
    mode = request.params.modeId;
    emit({ id: request.id, result: {} });
    return;
  }
  if (request.method === 'session/set_config_option') {
    modelSets += 1;
    if (request.params.value === 'no-ack[]' || request.params.configId === 'mode') { emit({ id: request.id, result: {} }); return; }
    emit({ id: request.id, result: { configOptions: [{ id: 'model', currentValue: request.params.value }] } });
    return;
  }
  if (request.method === 'session/cancel') {
    if (pending) { agent('late after abort'); finish('cancelled'); }
    return;
  }
  if (request.method === 'session/prompt') {
    pending = request.id;
    const text = textOf(request.params.prompt);
    if (text.includes('DISCONNECT')) { agent('partial'); process.exit(1); }
    if (text.includes('ABORT_LATE')) { agent('started'); return; }
    if (text.includes('REPORT_ARGV')) { agent(JSON.stringify({ argv: process.argv, mode, modelSets })); finish(); return; }
    if (text.includes('REPORT_MODE')) { agent(mode); finish(); return; }
    if (text.includes('PLAN_TEXT')) { agent('plan from text'); finish(); return; }
    if (text.includes('PLAN_SEEN')) {
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'plan', content: { text: 'structured' } } } });
      agent('also text');
      finish();
      return;
    }
    if (text.includes('image/png')) { agent('has-image'); finish(); return; }
    if (text.includes('CREATE_PLAN')) {
      emit({ id: 301, method: 'cursor/create_plan', params: { toolCallId: 'plan-1', name: 'Hello', overview: 'Add hello', plan: '1. write hello.txt', todos: [{ content: 'write', status: 'pending' }, { text: '' }, 'nope'] } });
      return;
    }
    if (text.includes('FALLBACK_PERMISSION')) {
      emit({ id: 401, method: 'session/request_permission', params: { toolCall: { title: 'deny fallback' } } });
      return;
    }
    if (text.includes('CREATE_PHASES')) {
      emit({ id: 302, method: 'cursor/create_plan', params: { plan: 'phase plan', todos: [], phases: [{ todos: [{ text: 'from phase' }] }, { todos: 'nope' }, 'bad'] } });
      return;
    }
    if (text.includes('THROW_PLAN')) { emit({ id: 340, method: 'cursor/create_plan', params: { toolCallId: 'boom', plan: 'saved' } }); return; }
    if (text.includes('PERMISSIONS')) {
      emit({ id: 310, method: 'session/request_permission', params: { toolCallId: 'shell-1', options: [{ optionId: 'allow-once' }, { id: 'reject-once' }, {}], toolCall: { title: 'npm test', kind: 'execute', rawInput: [{ text: 'a' }, { stdout: 'b', stderr: 'c' }, { content: { text: 'd' } }, {}] } } });
      return;
    }
    if (text.includes('THROW_PERMISSION_NONERROR')) {
      emit({ id: 316, method: 'session/request_permission', params: { toolCall: { title: 'explode-string', kind: 'execute' } } });
      return;
    }
    if (text.includes('THROW_PERMISSION')) {
      emit({ id: 315, method: 'session/request_permission', params: { toolCall: { title: 'explode', kind: 'execute' } } });
      return;
    }
    if (text.includes('PERMISSION_WRITE')) {
      emit({ id: 311, method: 'session/request_permission', params: { title: 'write file', toolCall: { kind: 'edit' }, options: [{ optionId: 'reject' }] } });
      return;
    }
    if (text.includes('ASK_INVALID')) {
      emit({ id: 321, method: 'cursor/ask_question', params: { questions: 'not-an-array' } });
      return;
    }
    if (text.includes('ASK_THROW')) {
      emit({ id: 322, method: 'cursor/ask_question', params: { toolCallId: 'q', questions: [{ id: 'q1', prompt: 'Choose', options: [{ id: 'yes', label: 'Yes' }] }] } });
      return;
    }
    if (text.includes('ASK')) {
      emit({ id: 320, method: 'cursor/ask_question', params: { toolCallId: 'q', title: 'Questions', questions: [
        { id: 'q1', prompt: 'Pick', allowMultiple: true, options: [{ id: 'yes', label: 'Yes' }, { id: '', label: 'skip' }, {}] },
        { id: '', prompt: 'skip' }, { id: 'q2', prompt: '' }, { prompt: 'missing id' },
      ] } });
      return;
    }
    if (text.includes('UNKNOWN')) { emit({ id: 330, method: 'cursor/unknown', params: { extra: true } }); return; }
    if (text.includes('SHAPES')) { shapes(); finish(); return; }
    agent('ok');
    finish();
    return;
  }
  if (request.id === 301 || request.id === 302 || request.id === 340) { agent(`plan-outcome:${JSON.stringify(request.result)}`); finish(); return; }
  if (request.id === 310) {
    decisions.push(request.result);
    emit({ id: 312, method: 'session/request_permission', params: { toolCall: { title: 'Read src/a.ts L2', kind: 'read' }, options: [{ optionId: 'allow' }] } });
    return;
  }
  if (request.id === 312) {
    decisions.push(request.result);
    emit({ id: 313, method: 'session/request_permission', params: { toolCall: { title: 'session tool' }, options: [{ optionId: 'nope' }] } });
    return;
  }
  if (request.id === 313) {
    decisions.push(request.result);
    emit({ id: 314, method: 'session/request_permission', params: { toolCall: { title: 'mcp tool', kind: 'mcp' } } });
    return;
  }
  if (request.id === 314 || request.id === 311 || request.id === 315) { decisions.push(request.result); agent(`permissions:${JSON.stringify(decisions)}`); finish(); return; }
  if (request.id === 316) { decisions.push(request.result); agent(`permissions:${JSON.stringify(decisions)}`); finish(); return; }
  if (request.id === 401) { fallbackDecisions.push(request.result); emit({ id: 402, method: 'session/request_permission', params: { toolCall: { title: 'session fallback' } } }); return; }
  if (request.id === 402) { fallbackDecisions.push(request.result); emit({ id: 403, method: 'session/request_permission', params: { toolCall: { title: 'once fallback' } } }); return; }
  if (request.id === 403) { fallbackDecisions.push(request.result); agent(`fallback-permissions:${JSON.stringify(fallbackDecisions)}`); finish(); return; }
  if (request.id === 320 || request.id === 321 || request.id === 322) { agent(`answers:${JSON.stringify(request.result)}`); finish(); return; }
  if (request.id === 330) { agent(`unknown:${JSON.stringify(request.result)}`); finish(); return; }
});
