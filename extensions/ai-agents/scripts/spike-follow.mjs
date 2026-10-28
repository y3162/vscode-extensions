#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.AI_AGENTS_SPIKE_OUT || path.join(tmpdir(), 'ai-agents-spikes');
const out = path.join(outDir, 'follow.json');
const steps = [];
const note = (step, data) => { steps.push({ step, ...data }); console.log('SPIKE', step, JSON.stringify(data).slice(0, 400)); };

function client(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const turnWaiters = [];
  let next = 0;
  const methods = [];
  let plan = null;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      methods.push(message.method);
      if (message.method === 'turn/completed') {
        const done = turnWaiters.shift();
        done?.();
      }
    }
    if (message.id !== undefined && message.method) {
      if (message.method === 'cursor/create_plan') {
        plan = { name: message.params?.name ?? null, todos: message.params?.todos?.length ?? 0, plan: typeof message.params?.plan === 'string' };
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })}\n`);
        return;
      }
      const result = message.method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'reject-once' } } : {};
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error).slice(0, 300))) : waiter.resolve(message.result ?? {});
    }
  });
  child.stderr.resume();
  const request = (method, params, ms = 180000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, ms);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const waitTurn = (ms = 180000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn timeout')), ms);
    turnWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
  return { request, notify, waitTurn, methods, plan: () => plan, kill: () => child.kill() };
}

async function acp() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-acp2-'));
  const rpc = client('agent', ['--model', 'composer-2.5', '--sandbox', 'enabled', 'acp'], cwd);
  try {
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'spike', version: '0.9.0' } });
    await rpc.request('authenticate', { methodId: 'cursor_login' });
    const created = await rpc.request('session/new', { cwd, mcpServers: [] });
    const modelIds = Array.isArray(created.models?.availableModels) ? created.models.availableModels.slice(0, 8).map((item) => item.modelId || item.id || item.name) : Object.keys(created.models ?? {}).slice(0, 8);
    await rpc.request('session/set_mode', { sessionId: created.sessionId, modeId: 'plan' });
    const prompted = await rpc.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Call the create_plan tool now with a 3-step plan named Hello to add hello.txt. Do not edit files.' }] });
    note('s1-set-mode-plan', { ok: true, modelIds, plan: rpc.plan(), stop: prompted.stopReason ?? null, methods: [...new Set(rpc.methods)] });
  } catch (error) {
    note('s1-set-mode-plan', { ok: false, plan: rpc.plan(), methods: [...new Set(rpc.methods)], error: String(error).slice(0, 300) });
  } finally { rpc.kill(); await rm(cwd, { recursive: true, force: true }); }
}

async function appServer() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-app2-'));
  const cli = path.resolve(root, '../../node_modules/@openai/codex/bin/codex.js');
  const rpc = client(process.execPath, [cli, 'app-server', '--listen', 'stdio://'], cwd);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'spike', title: 'spike', version: '0.9.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized', {});
    const childNote = rpc;
    // initialized notification
    const started = await rpc.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna' });
    const threadId = started.thread?.id;
    const planStarted = rpc.waitTurn();
    const plan = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with a short plan to add hello.txt. Do not edit files.', text_elements: [] }],
      model: 'gpt-6-luna',
      effort: 'low',
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-luna', reasoning_effort: 'low', developer_instructions: null } },
    }, 180000);
    await planStarted;
    const agentStarted = rpc.waitTurn();
    const agentTurn = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with the single word BUILD. Do not make a plan.', text_elements: [] }],
      model: 'gpt-5.6-luna',
      effort: 'low',
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-luna', reasoning_effort: 'low', developer_instructions: null } },
    }, 180000);
    await agentStarted;
    note('s4-collab', { ok: true, planTurn: plan.turn?.id ?? null, agentTurn: agentTurn.turn?.id ?? null, methods: [...new Set(childNote.methods)].slice(0, 25) });
  } catch (error) {
    note('s4-collab', { ok: false, error: String(error).slice(0, 400) });
  } finally { rpc.kill(); await rm(cwd, { recursive: true, force: true }); }
}

await mkdir(path.dirname(out), { recursive: true });
await acp();

await appServer();
await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), steps }, null, 2)}\n`);
console.log('SPIKE_DONE');
