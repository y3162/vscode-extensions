#!/usr/bin/env node
// Read-only capability spikes. Writes redacted JSON under test/fixtures/real.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test', 'fixtures', 'real');
const summary = { at: new Date().toISOString(), steps: [] };
const secret = /("|')?(api[_-]?key|token|authorization|secret|password|bearer)("|')?\s*[:=]\s*\S+/gi;

function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(secret, '$1=[redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]').slice(0, 4000);
}

function note(step, data) {
  summary.steps.push({ step, ...data });
  console.log(`SPIKE ${step} ${redact(data).slice(0, 500)}`);
}

async function save() {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

function rpcProcess(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  const notes = [];
  let next = 0;
  const onLine = (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const brief = { method: message.method, id: message.id, keys: message.result ? Object.keys(message.result) : undefined };
    notes.push(brief);
    if (message.id !== undefined && message.method) {
      const outcome = message.method === 'cursor/create_plan' ? { outcome: { outcome: 'cancelled' } }
        : message.method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'reject-once' } }
          : {};
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: outcome })}\n`);
      notes.push({ answered: message.method, sample: redact(message.params).slice(0, 800) });
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(redact(message.error)));
      else waiter.resolve(message.result ?? {});
    }
  };
  createInterface({ input: child.stdout }).on('line', onLine);
  child.stderr.resume();
  const request = (method, params, ms = 20000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, ms);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request, notes, kill() { child.kill(); } };
}

async function spikeAcpShape() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-acp-'));
  const rpc = rpcProcess('agent', ['--model', 'composer-2.5', '--sandbox', 'enabled', 'acp'], cwd);
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-agents-spike', version: '0.9.0' },
    });
    await rpc.request('authenticate', { methodId: 'cursor_login' });
    const created = await rpc.request('session/new', { cwd, mcpServers: [], mode: 'plan' });
    note('s1-session-new', {
      ok: true,
      initKeys: Object.keys(init ?? {}),
      sessionKeys: Object.keys(created ?? {}),
      modes: created?.modes ?? created?.availableModes ?? null,
      models: created?.models ? 'present' : null,
      config: created?.configOptions ? 'present' : null,
    });
  } catch (error) {
    note('s1-session-new', { ok: false, error: redact(error instanceof Error ? error.message : error) });
  } finally {
    rpc.kill();
    await rm(cwd, { recursive: true, force: true });
    await save();
  }
}

async function spikeAcpPlan(outcome) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-plan-'));
  const rpc = rpcProcess('agent', ['--model', 'composer-2.5', '--sandbox', 'enabled', 'acp'], cwd);
  const original = rpc.request;
  let plan = null;
  const answered = [];
  rpc.child.stdout.pause?.();
  // Replace the default create_plan answer by wrapping notes from the process reader is already cancelled.
  // A dedicated reader below re-implements the outcome. This function uses its own process instead.
  rpc.kill();
  const child = spawn('agent', ['--model', 'composer-2.5', '--sandbox', 'enabled', 'acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 0;
  const methods = [];
  const request = (method, params, ms = 180000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, ms);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) methods.push(message.method);
    if (message.id !== undefined && message.method) {
      if (message.method === 'cursor/create_plan') {
        plan = { keys: Object.keys(message.params ?? {}), name: message.params?.name, todoCount: message.params?.todos?.length ?? 0 };
        const result = outcome === 'accepted' ? { outcome: { outcome: 'accepted' } }
          : outcome === 'rejected' ? { outcome: { outcome: 'rejected', reason: 'revise the plan' } }
            : { outcome: { outcome: 'cancelled' } };
        answered.push(outcome);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        return;
      }
      const result = message.method === 'session/request_permission'
        ? { outcome: { outcome: 'selected', optionId: 'reject-once' } } : {};
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(redact(message.error)));
      else waiter.resolve(message.result ?? {});
    }
  });
  child.stderr.resume();
  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'ai-agents-spike', version: '0.9.0' },
    });
    await request('authenticate', { methodId: 'cursor_login' });
    const created = await request('session/new', { cwd, mcpServers: [], mode: 'plan' });
    const prompt = await request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Create a short plan named Hello to add hello.txt. Use the plan tool. Do not modify files.' }],
    }, 180000);
    note(`s1-plan-${outcome}`, { ok: true, plan, stop: prompt?.stopReason ?? null, methods: [...new Set(methods)].slice(0, 30), answered });
  } catch (error) {
    note(`s1-plan-${outcome}`, { ok: false, plan, methods: [...new Set(methods)].slice(0, 30), error: redact(error instanceof Error ? error.message : error) });
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
    await save();
  }
}

async function spikeAppServerShape() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-app-'));
  const cli = path.join(root, '..', '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const rpc = rpcProcess(process.execPath, [cli, 'app-server', '--listen', 'stdio://'], cwd);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'spike', title: 'spike', version: '0.9.0' }, capabilities: { experimentalApi: true } });
    rpc.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const started = await rpc.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna' });
    const threadId = started?.thread?.id ?? started?.threadId;
    let terminals = null;
    let terminalError = null;
    try { terminals = await rpc.request('thread/backgroundTerminals/list', { threadId, limit: 5 }); }
    catch (error) { terminalError = redact(error instanceof Error ? error.message : error); }
    note('s6-app-server', { ok: true, thread: Boolean(threadId), terminals: terminals ? redact(terminals).slice(0, 500) : null, terminalError });
  } catch (error) {
    note('s6-app-server', { ok: false, error: redact(error instanceof Error ? error.message : error) });
  } finally {
    rpc.kill();
    await rm(cwd, { recursive: true, force: true });
    await save();
  }
}

async function spikeCursorSdk() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-spike-sdk-'));
  try {
    const { Agent, Cursor, JsonlLocalAgentStore } = await import('@cursor/sdk');
    const auth = await Cursor.auth.status();
    const models = await Cursor.models.list();
    const ids = models.map((model) => model.id);
    note('s2-models', { auth: auth.status, composer: ids.includes('composer-2.5'), fast: ids.includes('composer-2.5-fast') });
    if (auth.status !== 'logged-in' || !ids.includes('composer-2.5')) return;
    const agent = await Agent.create({
      model: { id: 'composer-2.5' },
      mode: 'plan',
      local: { cwd, store: new JsonlLocalAgentStore(cwd), sandboxOptions: { enabled: true }, settingSources: [] },
    });
    const names = [];
    try {
      const run = await agent.send('Create a short plan to add hello.txt. Do not modify files.', { mode: 'plan', model: { id: 'composer-2.5' } });
      for await (const event of run.stream()) {
        if (event.type === 'tool_call') names.push(`${event.name}:${event.status}`);
        if (names.length > 40) break;
      }
      const result = await run.wait();
      const follow = await agent.send('Reply with the single word BUILD. Do not create a plan.', { mode: 'agent', model: { id: 'composer-2.5-fast' } });
      let followText = '';
      for await (const event of follow.stream()) {
        if (event.type === 'assistant') followText += event.message?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
      }
      const followResult = await follow.wait();
      note('s2-plan-build', {
        ok: true,
        tools: names.slice(0, 30),
        status: result.status,
        model: result.model?.id ?? null,
        followStatus: followResult.status,
        followModel: followResult.model?.id ?? null,
        followHasBuild: /BUILD/i.test(followText),
      });
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  } catch (error) {
    note('s2-plan-build', { ok: false, error: redact(error instanceof Error ? error.message : error) });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await save();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await spikeAcpShape();
  await spikeAppServerShape();
  if (process.env.AI_AGENTS_SPIKE_INFERENCE === '1') {
    await spikeAcpPlan('cancelled');
    await spikeCursorSdk();
  } else note('inference', { skipped: true, reason: 'Set AI_AGENTS_SPIKE_INFERENCE=1 to run billed plan spikes.' });
  await save();
  console.log('SPIKE_DONE');
}

main().catch((error) => {
  note('fatal', { error: redact(error instanceof Error ? error.message : error) });
  console.log('SPIKE_DONE');
  process.exitCode = 1;
});
