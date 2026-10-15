#!/usr/bin/env node
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pendingTurn;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'fixture', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
  else if (request.method === 'initialized') return;
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    emit({ id: request.id, result: { thread: { id: 'thread-1', title: 'Fixture' }, instructionSources: ['AGENTS.md'], threadId: 'thread-1' } });
  } else if (request.method === 'thread/list') {
    emit({ id: request.id, result: { data: [{ id: 'thread-1', title: 'Fixture', updatedAt: '2026-10-16T00:00:00.000Z' }] } });
  } else if (request.method === 'turn/start') {
    pendingTurn = request.id;
    if (String(request.params.input?.[0]?.text || '').includes('NEED_APPROVAL')) {
      emit({ id: 50, method: 'item/commandExecution/requestApproval', params: { approvalId: 'approval-1', command: 'npm test', reason: 'fixture command' } });
      return;
    }
    emit({ method: 'item/agentMessage/delta', params: { itemId: 'agent-1', delta: 'app ' } });
    emit({ method: 'item/agentMessage/delta', params: { itemId: 'agent-1', delta: 'server' } });
    emit({ method: 'turn/completed', params: { turnId: 'turn-1' } });
    emit({ id: request.id, result: { turn: { id: 'turn-1' } } });
  } else if (request.method === 'turn/interrupt') emit({ id: request.id, result: {} });
  else if (request.id === 50 || (pendingTurn && request.result)) {
    emit({ method: 'item/completed', params: { item: { id: 'agent-1', type: 'agentMessage', text: `approved:${request.result?.decision}` } } });
    emit({ method: 'turn/completed', params: { turnId: 'turn-1' } });
    emit({ id: pendingTurn, result: { turn: { id: 'turn-1' } } });
    pendingTurn = undefined;
  } else if (request.method === 'thread/fork') emit({ id: request.id, result: { thread: { id: 'thread-2' } } });
  else if (request.method === 'thread/compact/start') emit({ id: request.id, result: {} });
  else if (request.method === 'account/rateLimits/read') emit({ id: request.id, result: { rateLimits: { primary: { usedPercent: 12 } } } });
  else if (request.method === 'skills/list') emit({ id: request.id, result: { data: [{ name: 'fixture-skill' }] } });
  else if (request.method === 'mcpServerStatus/list') emit({ id: request.id, result: { data: [{ name: 'fixture-mcp' }] } });
  else if (request.id !== undefined) emit({ id: request.id, result: {} });
});
