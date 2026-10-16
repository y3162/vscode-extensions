import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { createSession } from '../../src/providers/index.js';
import { listModels } from '../../src/providers/models.js';
import { SessionRegistry } from '../../src/session-registry.js';
import type { AgentSession, AgentUpdate, Backend, Provider, Selection } from '../../src/types.js';

const enabled = process.env.AI_AGENTS_LIVE_RUNTIME === '1';
const interactions = { requestPermission: async () => 'allow-once' as const, requestPlan: async () => 'rejected' as const, requestAnswers: async () => ({}) };
async function workspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-runtime-'));
  execFileSync('git', ['init', '-q'], { cwd });
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
async function until(check: () => boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), 'condition did not arrive before deadline');
}
async function preferred(provider: Provider) {
  const models = await listModels({ provider });
  const id = provider === 'codex' ? 'gpt-6-luna' : 'composer-2.5';
  assert.ok(models.some((model) => model.id === id), `${id} is absent from the actual model list`);
  return id;
}
function options(provider: Provider, backend: Backend, cwd: string, model: string) {
  return { provider, backend, cwd, model, storagePath: path.join(cwd, 'store'), sandbox: provider === 'codex' ? 'workspace-write' : 'enabled', approval: 'never', interactions };
}

for (const backend of ['app-server', 'acp'] as const) {
  test(`${backend}: real parallel children reach distinct normalized cards`, { skip: !enabled, timeout: 240000 }, async () => {
    const { cwd, cleanup } = await workspace();
    const provider = backend === 'acp' ? 'cursor' : 'codex';
    const model = backend === 'acp' ? '' : await preferred(provider);
    const session = await createSession(options(provider, backend, cwd, model));
    const updates: Array<{ at: number; update: AgentUpdate }> = [];
    const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push({ at: Date.now(), update }));
    try {
      await session.run('Explicit parallel verification: launch TWO independent child agents concurrently, alpha and beta, before waiting for either. Each must run a safe shell command printing its name and a timestamp, sleep 6 seconds, then print its name and another timestamp. No file changes. Launch both, then wait for both using your supported tools and return actual results. Do not simulate tasks.', AbortSignal.timeout(200000), (update) => updates.push({ at: Date.now(), update }));
      const children = new Map(updates.flatMap(({ update }) => update.meta?.subagent ? [[update.meta.subagent.id, update.meta.subagent] as const] : []));
      console.log('RUNTIME_CHILD_STATES', backend, JSON.stringify([...children.values()].map(({ id, agentId, status, name }) => ({ id, agentId, status, name }))));
      assert.ok(children.size >= 2);
      const intervals = [...children.values()].filter((child) => child.status === 'completed').map((child) => ({ id: child.agentId ?? child.id, model: child.model, startedAt: child.startedAt, endedAt: child.endedAt, durationMs: child.durationMs }));
      assert.ok(intervals.length >= 2);
      assert.ok(intervals.every((item) => item.startedAt && item.endedAt));
      assert.ok(intervals.some((left, index) => intervals.slice(index + 1).some((right) => Math.max(left.startedAt!, right.startedAt!) < Math.min(left.endedAt!, right.endedAt!))));
      console.log('RUNTIME_PARALLEL', backend, JSON.stringify(intervals));
    } finally { unsubscribe(); await session.dispose(); await cleanup(); }
  });
}

test('App Server: natural exit and terminate update the original chat without another turn', { skip: !enabled, timeout: 180000 }, async () => {
  const { cwd, cleanup } = await workspace();
  const model = await preferred('codex');
  const selection: Selection = { provider: 'codex', cwd, model };
  let session: AgentSession | undefined;
  const controller = new ChatController(selection, async () => (session = await createSession(options('codex', 'app-server', cwd, model))), () => {});
  const other = new ChatController(selection, async () => { throw new Error('No run expected'); }, () => {});
  const registry = new SessionRegistry(controller, 'agent');
  registry.add({ key: 'other', controller: other, mode: 'agent' });
  try {
    const command = 'python3 -u -c "import time,sys; print(\"LIVE_STDOUT\",flush=True); print(\"LIVE_STDERR\",file=sys.stderr,flush=True); time.sleep(10); print(\"LIVE_DONE\",flush=True)"';
    await controller.send(`Run exactly one finite process using exec_command with yield_time_ms 1000: ${command}. As soon as a running process ID is returned, end this turn with that ID. Do not wait, poll, write_stdin, or stop it. Do not edit files.`);
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().terminals.length, 1);
    registry.focus('other');
    assert.equal(registry.runningCount(), 0, 'only parent turns count toward the concurrency limit');
    await controller.hibernate();
    assert.equal(controller.hasSession(), true);
    await until(() => controller.snapshot().terminals.length === 0, 30000);
    registry.focus('front');
    assert.ok(controller.snapshot().messages.some((item) => item.tool?.exitCode === 0 && /LIVE_DONE/.test(item.text) && /LIVE_STDERR/.test(item.text)));
    assert.deepEqual(other.snapshot().messages, []);
    await controller.send('Run one finite background process using exec_command with yield_time_ms 1000: sleep 45. End this turn immediately with its running process ID. Do not poll, wait or stop it.');
    const processId = controller.snapshot().terminals[0]?.processId;
    assert.ok(processId);
    await session!.terminateBackgroundTerminal!(processId);
    assert.equal(controller.snapshot().terminals.length, 0);
    console.log('RUNTIME_TERMINAL', JSON.stringify({ naturalExit: true, output: true, switchedChat: true, terminatedProcessId: processId }));
  } finally { const terminals = await session?.listBackgroundTerminals?.().catch(() => []); for (const row of terminals ?? []) await session?.terminateBackgroundTerminal?.(row.processId); await controller.dispose(); await other.dispose(); await cleanup(); }
});

for (const [provider, backend] of [['cursor', 'sdk'], ['cursor', 'acp'], ['codex', 'app-server']] as const) {
  test(`${provider}/${backend}: real Plan revision and Build preserve the conversation`, { skip: !enabled, timeout: 300000 }, async () => {
    const { cwd, cleanup } = await workspace();
    const model = backend === 'acp' ? '' : await preferred(provider);
    const selection: Selection = { provider, cwd, model };
    const controller = new ChatController(selection, async (next, context) => createSession({ ...options(provider, backend, cwd, model), ...next, signal: context?.signal, resumeId: context?.resumeId }), () => {});
    try {
      controller.setModePreference('plan');
      await controller.send('Create a concise plan to add hello.txt with exactly hello followed by a newline. Do not implement or edit files. Stop after the plan.');
      assert.equal(controller.snapshot().plan.phase, 'ready');
      await assert.rejects(access(path.join(cwd, 'hello.txt')));
      const first = controller.planSnapshot();
      const id = controller.sessionId();
      controller.setBuildModel(selection, 'Verified build model');
      await controller.send('Revise this plan: hello.txt must contain exactly revised followed by a newline. Do not implement or edit files. Stop after the updated plan.');
      const revised = controller.planSnapshot();
      assert.equal(revised.phase, 'ready');
      assert.equal(revised.current?.revision, first.current!.revision + 1);
      assert.equal(revised.build?.label, 'Verified build model');
      assert.equal(controller.sessionId(), id);
      await Promise.all([controller.build(revised.current!.id, revised.current!.revision, selection), controller.build(revised.current!.id, revised.current!.revision, selection)]);
      assert.equal(controller.snapshot().plan.phase, 'implemented');
      assert.equal(controller.sessionId(), id);
      assert.equal(await readFile(path.join(cwd, 'hello.txt'), 'utf8'), 'revised\n');
      const restored = new ChatController(selection, async () => { throw new Error('implemented plan must not run'); }, () => {});
      restored.restorePlan(controller.planSnapshot());
      await assert.rejects(restored.build(revised.current!.id, revised.current!.revision, selection), /準備/);
      await restored.dispose();
      console.log('RUNTIME_PLAN_BUILD', JSON.stringify({ provider, backend, model: model || 'runtime-default', revision: revised.current!.revision, sameSession: true, duplicateBuildPrevented: true }));
    } finally { await controller.dispose(); await cleanup(); }
  });
}

test('App Server: stopping the parent does not invent child completion', { skip: !enabled, timeout: 180000 }, async () => {
  const { cwd, cleanup } = await workspace();
  const model = await preferred('codex');
  const selection: Selection = { provider: 'codex', cwd, model };
  const observed: Array<{ at: number; busy: boolean; children: Array<{ id: string; status: string }> }> = [];
  const controller = new ChatController(selection, async () => createSession(options('codex', 'app-server', cwd, model)), (state) => observed.push({ at: Date.now(), busy: state.busy, children: state.subagents.map(({ id, status }) => ({ id, status })) }));
  const watchdog = setTimeout(() => controller.stop(), 120000);
  try {
    const pending = controller.send('Explicit cancellation verification: launch TWO child agents concurrently. Each child must run sleep 15, then return done. After launching both, the parent must run sleep 40 before waiting for the children. No file edits. Use actual tools; do not simulate children.');
    await until(() => controller.snapshot().subagents.filter((child) => child.status === 'running').length >= 2, 90000);
    const before = controller.snapshot().subagents.map(({ id, status }) => ({ id, status }));
    controller.stop();
    await pending;
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().turns.at(-1)?.status, 'cancelled');
    const after = controller.snapshot().subagents.map(({ id, status }) => ({ id, status }));
    await new Promise((resolve) => setTimeout(resolve, 18000));
    console.log('RUNTIME_PARENT_STOP', JSON.stringify({ before, after, later: controller.snapshot().subagents.map(({ id, status }) => ({ id, status })), updatesAfterParent: observed.filter((entry) => !entry.busy && entry.children.length).length }));
  } finally {
    clearTimeout(watchdog);
    controller.stop();
    const session = controller.currentSession();
    for (const row of await session?.listBackgroundTerminals?.().catch(() => []) ?? []) await session?.terminateBackgroundTerminal?.(row.processId);
    await controller.dispose(); await cleanup();
  }
});
