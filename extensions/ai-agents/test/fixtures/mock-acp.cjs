#!/usr/bin/env node
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let sessionId = 'acp-session';
let pendingPrompt;
let setModeOk = 0;
let setModeFail = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    emit({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
  } else if (request.method === 'authenticate') emit({ id: request.id, result: {} });
  else if (request.method === 'session/new' || request.method === 'session/load') {
    sessionId = request.params.sessionId || 'acp-session';
    if (request.method === 'session/load') {
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } } } });
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } } } });
    }
    emit({ id: request.id, result: { sessionId } });
  } else if (request.method === 'session/list') {
    emit({ id: request.id, result: { sessions: [{ sessionId, title: 'ACP fixture', updatedAt: '2026-10-16T00:00:00.000Z' }] } });
  } else if (request.method === 'session/set_mode') {
    if (request.params?.modeId === 'plan') {
      setModeFail += 1;
      emit({ id: request.id, error: { message: 'mode rejected' } });
    } else {
      setModeOk += 1;
      emit({ id: request.id, result: {} });
    }
  } else if (request.method === 'session/set_config_option') emit({ id: request.id, result: {} });
  else if (request.method === 'session/prompt') {
    pendingPrompt = request.id;
    const prompt = JSON.stringify(request.params.prompt);
    if (prompt.includes('REAL_TASKS')) {
      const captured = require('./runtime-090.json');
      for (const row of captured.acp) {
        if (row.method === 'request') emit({ id: 100, method: row.params.method, params: row.params.params });
        else emit({ method: row.method, params: row.params });
      }
      emit({ id: request.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = undefined;
      return;
    }
    if (prompt.includes('NEED_PERMISSION')) {
      emit({ id: 90, method: 'session/request_permission', params: { toolCallId: 'call-1', toolCall: { title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } } } });
      return;
    }
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `acp answer modes:${setModeOk}/${setModeFail}` } } } });
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Read file', status: 'completed', content: [{ type: 'diff', path: 'src/main.ts', oldText: 'old', newText: 'new' }] } } });
    emit({ id: request.id, result: { stopReason: 'end_turn' } });
    pendingPrompt = undefined;
  } else if (request.id === 90) {
    emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${JSON.stringify(request.result)}` } } } });
    emit({ id: pendingPrompt, result: { stopReason: 'end_turn' } });
    pendingPrompt = undefined;
  }
});
