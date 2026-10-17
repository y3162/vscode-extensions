#!/usr/bin/env node
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let sessionId = 'acp-session';
let pendingPrompt;
let setModeOk = 0;
let setModeFail = 0;
let currentMode = 'agent';
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    emit({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
  } else if (request.method === 'authenticate') emit({ id: request.id, result: {} });
  else if (request.method === 'session/new' || request.method === 'session/load') {
    sessionId = request.params.sessionId || 'acp-session';
    if (sessionId === 'saved-plan') currentMode = 'plan';
    if (request.method === 'session/load') {
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } } } });
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } } } });
    }
    if (sessionId === 'repeat-history') {
      for (let turn = 0; turn < 2; turn++) {
        emit({ method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `question ${turn}` } } } });
        emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
        emit({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: `read-${turn}`, title: 'Read file', status: 'completed' } } });
        emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
      }
    }
    emit({ id: request.id, result: { sessionId, models: { currentModelId: 'default[]', availableModels: [{modelId:'default[]',name:'Auto'}, {modelId:'composer-2.5[fast=true]',name:'composer-2.5'}, {modelId:'rejected[]',name:'rejected'}, {modelId:'no-ack[]',name:'no-ack'}] } } });
  } else if (request.method === 'session/list') {
    emit({ id: request.id, result: { sessions: [{ sessionId, title: 'ACP fixture', updatedAt: '2026-10-16T00:00:00.000Z' }] } });
  } else if (request.method === 'session/set_mode') {
    if (request.params?.modeId === 'plan') {
      setModeFail += 1;
      emit({ id: request.id, error: { message: 'mode rejected' } });
    } else {
      currentMode = request.params.modeId;
      if (request.params?.modeId === 'ask') emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'idle mode update' } } } });
      setModeOk += 1;
      emit({ id: request.id, result: {} });
    }
  } else if (request.method === 'session/set_config_option') {
    if (request.params.value === 'rejected[]') emit({ id: request.id, error: { message: 'model refused' } });
    else emit({ id: request.id, result: request.params.configId === 'model' && request.params.value !== 'no-ack[]' ? {configOptions:[{id:'model',currentValue:request.params.value}]} : {} });
  }
  else if (request.method === 'session/prompt') {
    pendingPrompt = request.id;
    const prompt = JSON.stringify(request.params.prompt);
    if (prompt.includes('REPORT_MODE')) {
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: currentMode } } } });
      emit({ id: request.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = undefined;
      return;
    }
    if (prompt.includes('REPEATED_FINAL')) {
      const update = (text) => emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      update('done');
      emit({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', status: 'completed' } } });
      update('done');
      update(' done');
      update(' done');
      emit({ id: request.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = undefined;
      return;
    }
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
