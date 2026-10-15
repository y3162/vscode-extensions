import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexLaunch } from '../../src/providers/codex-binary.js';
import { createCodexAppServerSession } from '../../src/providers/codex-app-server.js';
import { createCursorAcpSession } from '../../src/providers/cursor-acp.js';
import { listModels } from '../../src/providers/models.js';
import type { AgentUpdate } from '../../src/types.js';

const enabled = process.env.AI_AGENTS_REAL_PROTOCOL === '1';
const interactions = {
  requestPermission: async () => 'deny' as const,
  requestPlan: async () => 'rejected' as const,
  requestAnswers: async () => ({}),
};

function which(command: string): string {
  return execFileSync('which', ['-a', command], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0] ?? '';
}

function textOf(updates: AgentUpdate[]): string {
  return updates.map((update) => update.text).join('\n');
}

async function temporary(): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-real-'));
  return { cwd, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('Cursor ACP speaks the installed CLI protocol', { skip: !enabled, timeout: 120000 }, async () => {
  const agentPath = which('agent');
  assert.ok(agentPath, 'Cursor CLI (agent) was not found on PATH');
  const version = execFileSync(agentPath, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`cursor-cli ${version} ${agentPath}`);
  const { cwd, cleanup } = await temporary();
  try {
    const session = await createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, backend: 'acp', agentPath, interactions,
    });
    try {
      assert.ok(session.sessionId);
      await session.setMode?.('plan');
      await session.setMode?.('ask');
      await session.setMode?.('agent');
      const listed = await session.listSessions?.();
      assert.ok(listed?.some((item) => item.id === session.sessionId));
      const updates: AgentUpdate[] = [];
      await session.run('Reply with the single word pong. Do not use tools.', new AbortController().signal, (update) => updates.push(update));
      assert.match(textOf(updates), /pong/i);
      const resumeId = session.sessionId;
      await session.dispose();
      assert.equal(session.closed, true);
      const started = Date.now();
      await assert.rejects(() => session.run('again', new AbortController().signal, () => {}), /closed|exited/);
      assert.ok(Date.now() - started < 1000);

      const restored = await createCursorAcpSession({
        provider: 'cursor', cwd, model: '', storagePath: cwd, backend: 'acp', agentPath, resumeId, interactions,
      });
      try {
        const replay: string[] = [];
        await restored.loadTranscript?.((message) => replay.push(message.text));
        assert.match(replay.join('\n'), /pong/i);
        const cancel = new AbortController();
        const cancelled = restored.run('Reply with the single word pong. Do not use tools.', cancel.signal, () => {});
        setTimeout(() => cancel.abort(), 300);
        await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
      } finally { await restored.dispose(); }
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});

test('Codex App Server speaks the bundled 0.162.1 protocol', { skip: !enabled, timeout: 180000 }, async () => {
  const { cwd, cleanup } = await temporary();
  const threads: string[] = [];
  try {
    const observed = await observeThread(cwd, {
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { model_reasoning_effort: 'low' },
    });
    threads.push(observed.id);
    assert.equal(observed.sandboxType, 'readOnly');
    assert.equal(observed.effort, 'low');
    assert.ok(observed.modelCount > 0);
    const writable = await observeThread(cwd, { approvalPolicy: 'never', sandbox: 'workspace-write' });
    threads.push(writable.id);
    assert.equal(writable.sandboxType, 'workspaceWrite');

    const session = await createCodexAppServerSession({
      provider: 'codex', cwd, model: '', storagePath: cwd, backend: 'app-server',
      sandbox: 'read-only', approval: 'never',
      modelParams: [{ id: 'modelReasoningEffort', value: 'low' }],
      interactions,
    });
    threads.push(session.sessionId ?? '');
    try {
      const models = await listModels({ provider: 'codex', cwd });
      assert.ok(models.length > 0);
      assert.ok(models.every((model) => model.id && model.label));
      const updates: AgentUpdate[] = [];
      await session.run('Reply with the single word pong. Do not use tools.', new AbortController().signal, (update) => updates.push(update));
      assert.match(textOf(updates), /pong/i);
      const resumeId = session.sessionId;
      assert.ok(resumeId);
      await session.dispose();
      const restored = await createCodexAppServerSession({
        provider: 'codex', cwd, model: '', storagePath: cwd, backend: 'app-server',
        sandbox: 'read-only', approval: 'never', resumeId, interactions,
      });
      try {
        const replay: string[] = [];
        await restored.loadTranscript?.((message) => replay.push(message.text));
        assert.match(replay.join('\n'), /pong/i);
        const cancel = new AbortController();
        const cancelled = restored.run('Reply with the single word pong. Do not use tools.', cancel.signal, () => {});
        setTimeout(() => cancel.abort(), 400);
        await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
      } finally { await restored.dispose(); }
    } finally { await session.dispose(); }
  } finally {
    await deleteThreads(cwd, threads.filter(Boolean));
    await cleanup();
  }
});

async function observeThread(cwd: string, params: Record<string, unknown>): Promise<{ id: string; sandboxType: string; effort: string; modelCount: number }> {
  const launch = codexLaunch(undefined, ['app-server', '--listen', 'stdio://'], cwd);
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let next = 0;
  let modelCount = 0;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string };
    if (message.id !== undefined && message.method) {
      child.stdin?.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'request failed'));
    else waiter.resolve(message.result ?? {});
  });
  const request = (method: string, body: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 20000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin?.write(`${JSON.stringify({ id, method, params: body })}\n`);
  });
  try {
    await request('initialize', { clientInfo: { name: 'ai_agents_vscode', title: 'AI Agents', version: '0.6.0' }, capabilities: { experimentalApi: true } });
    child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const models = await request('model/list', { limit: 5, includeHidden: false });
    modelCount = Array.isArray(models.data) ? models.data.length : 0;
    const started = await request('thread/start', { cwd, ...params });
    const thread = started.thread as { id?: string } | undefined;
    const sandbox = started.sandbox as { type?: string } | undefined;
    return {
      id: thread?.id ?? '',
      sandboxType: sandbox?.type ?? '',
      effort: typeof started.reasoningEffort === 'string' ? started.reasoningEffort : '',
      modelCount,
    };
  } finally {
    child.stdin?.end();
    child.kill();
  }
}

async function deleteThreads(cwd: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const launch = codexLaunch(undefined, ['app-server', '--listen', 'stdio://'], cwd);
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0;
  const pending = new Map<number, () => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id !== undefined && message.method) {
      child.stdin?.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    if (message.id !== undefined) pending.get(message.id)?.();
  });
  const request = (method: string, params: unknown) => new Promise<void>((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    setTimeout(resolve, 3000);
  });
  await request('initialize', { clientInfo: { name: 'ai_agents_vscode', title: 'AI Agents', version: '0.6.0' } });
  child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  for (const threadId of ids) await request('thread/delete', { threadId });
  child.kill();
}
