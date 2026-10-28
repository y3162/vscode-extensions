import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatController } from '../../src/chat-controller.js';
import { createSession } from '../../src/providers/index.js';
import { listModels } from '../../src/providers/models.js';
import { SessionRegistry } from '../../src/session-registry.js';
import { TerminalMonitor } from '../../src/terminal-monitor.js';
import type { AgentSession, AgentUpdate, Backend, Provider, Selection } from '../../src/types.js';

const enabled = process.env.AI_AGENTS_LIVE_RUNTIME === '1';
const interactions = { requestPermission: async () => 'allow-once' as const, requestPlan: async () => 'rejected' as const, requestAnswers: async () => ({}) };
async function workspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-runtime-'));
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
    const model = await preferred(provider);
    const session = await createSession(options(provider, backend, cwd, model));
    const updates: Array<{ hostObservedAt: number; update: AgentUpdate }> = [];
    const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push({ hostObservedAt: Date.now(), update }));
    try {
      await session.run('Explicit parallel verification: launch TWO independent child agents concurrently, alpha and beta, before waiting for either. Alpha must run this exact shell command: `printf "ALPHA_START:%s\\n" "$(date +%s)"; sleep 6; printf "ALPHA_END:%s\\n" "$(date +%s)"`. Beta must run this exact shell command: `printf "BETA_START:%s\\n" "$(date +%s)"; sleep 6; printf "BETA_END:%s\\n" "$(date +%s)"`. No file changes. Launch both before waiting for either. Return the four actual command output lines verbatim, labelled with the child that produced them. Do not simulate tasks or invent output.', AbortSignal.timeout(200000), (update) => updates.push({ hostObservedAt: Date.now(), update }));
      const children = new Map(updates.flatMap(({ update }) => update.meta?.subagent ? [[update.meta.subagent.id, update.meta.subagent] as const] : []));
      console.log('RUNTIME_CHILD_STATES', backend, JSON.stringify([...children.values()].map(({ id, agentId, status, name }) => ({ id, agentId, status, name }))));
      if (backend === 'app-server') {
        const waitEvents = updates.flatMap(({ update }) => update.meta?.type === 'subagentWait' && update.meta.subagentWait ? [update.meta.subagentWait.waiting] : []);
        console.log('RUNTIME_SUBAGENT_WAIT_EVENTS', JSON.stringify(waitEvents));
        assert.ok(waitEvents.includes(true), 'the App Server must publish an explicit active wait item');
        assert.ok(waitEvents.includes(false), 'the completed wait item must clear the parent wait state');
      }
      if (backend === 'acp') {
        const alpha = [...children.values()].find((child) => /^Alpha\b.*\bverification\b/i.test(child.name));
        const beta = [...children.values()].find((child) => /^Beta\b.*\bverification\b/i.test(child.name));
        assert.ok(alpha && beta, 'the two requested children must have distinct public task records');
        const assistantSegments = new Map(updates.flatMap(({ update }) => update.role === 'assistant' ? [[update.id, update.text] as const] : []));
        const returnedOutput = [...assistantSegments.values()].join('\n');
        const publicChildren = [...children.values()].map(({ id, agentId, model, name, status, startedAt, endedAt, durationMs, resultPreview }) => ({
          id: agentId ?? id, model, name, status,
          extensionHostObservedStartAt: startedAt,
          extensionHostObservedEndAt: endedAt,
          backendReportedDurationMs: durationMs,
          resultPreview,
        }));
        console.log('RUNTIME_PARALLEL_EVIDENCE', backend, JSON.stringify({ parentStatus: 'completed', model: alpha.model ?? beta.model, children: publicChildren, returnedOutput }));
        assert.equal(alpha.status, 'completed');
        assert.equal(beta.status, 'completed');
        const hostObservedIntervals = {
          alpha: alpha.startedAt !== undefined && alpha.endedAt !== undefined ? [alpha.startedAt, alpha.endedAt] : undefined,
          beta: beta.startedAt !== undefined && beta.endedAt !== undefined ? [beta.startedAt, beta.endedAt] : undefined,
        };
        const alphaOutput = alpha.resultPreview ?? '';
        const betaOutput = beta.resultPreview ?? '';
        assert.ok(alphaOutput.includes('ALPHA_START:') && alphaOutput.includes('ALPHA_END:'), 'alpha task result must carry its command output');
        assert.ok(betaOutput.includes('BETA_START:') && betaOutput.includes('BETA_END:'), 'beta task result must carry its command output');
        const timestamp = (output: string, label: string) => Number(new RegExp(`${label}:(\\d+)`).exec(output)?.[1] ?? NaN);
        const alphaStart = timestamp(alphaOutput, 'ALPHA_START');
        const alphaEnd = timestamp(alphaOutput, 'ALPHA_END');
        const betaStart = timestamp(betaOutput, 'BETA_START');
        const betaEnd = timestamp(betaOutput, 'BETA_END');
        assert.ok([alphaStart, alphaEnd, betaStart, betaEnd].every(Number.isFinite), 'the parent must return all four actual timestamped child command output lines');
        assert.ok(alphaEnd - alphaStart >= 5 && betaEnd - betaStart >= 5, 'both returned command intervals must reflect the requested sleep');
        const commandOverlapSeconds = Math.min(alphaEnd, betaEnd) - Math.max(alphaStart, betaStart);
        assert.ok(commandOverlapSeconds > 0, 'the actual timestamped child commands must overlap, independent of task-tool timing');
        for (const [name, child, start, end] of [['alpha', alpha, 'ALPHA_START', 'ALPHA_END'], ['beta', beta, 'BETA_START', 'BETA_END']] as const) {
          if (child.resultPreview) assert.ok(child.resultPreview.includes(`${start}:`) && child.resultPreview.includes(`${end}:`), `${name} public child result must agree with its returned command output`);
        }
        console.log('RUNTIME_PARALLEL', backend, JSON.stringify({
          model: alpha.model ?? beta.model,
          extensionHostObservedIntervals: hostObservedIntervals,
          backendCommandIntervalsUnixSeconds: { alpha: [alphaStart, alphaEnd], beta: [betaStart, betaEnd] },
          commandOverlapSeconds,
          returnedOutput,
        }));
      } else {
        assert.ok(children.size >= 2);
        const childStates = [...children.values()].map((child) => ({
          id: child.agentId ?? child.id,
          model: child.model,
          status: child.status,
          extensionHostObservedStartAt: child.startedAt,
          extensionHostObservedEndAt: child.endedAt,
          backendReportedDurationMs: child.durationMs,
        }));
        assert.ok(childStates.filter((child) => child.status === 'completed').length >= 2);
        console.log('RUNTIME_PARALLEL', backend, JSON.stringify({ childStates, note: 'Extension Host observation timestamps are not evidence of Backend execution overlap.' }));
      }
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

test('App Server: Background Terminal recovers flushed initial stdout from the live item snapshot', { skip: process.env.AI_AGENTS_LIVE_TERMINAL_TEST !== '1', timeout: 120000 }, async () => {
  const { cwd, cleanup } = await workspace();
  const model = await preferred('codex');
  const session = await createSession(options('codex', 'app-server', cwd, model));
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  let monitor: TerminalMonitor | undefined;
  let output = '';
  const script = 'import sys,time; print("AI_AGENTS_INITIAL_STDOUT",flush=True); print("AI_AGENTS_INITIAL_STDERR",file=sys.stderr,flush=True); time.sleep(12); print("AI_AGENTS_LATE_STDOUT",flush=True); print("AI_AGENTS_LATE_STDERR",file=sys.stderr,flush=True)';
  const command = `python3 -u -c '${script}'`;
  try {
    await session.run(
      `Run exactly one background shell process with exec_command and yield_time_ms 1000, without tty, using this command: ${command}. Return immediately with the actual process ID. Do not wait, poll, terminate, or start a second process. Do not edit files.`,
      AbortSignal.timeout(90000),
      (update) => updates.push(update),
    );
    const rows = await session.listBackgroundTerminals!();
    assert.equal(rows.length, 1, 'the actual process must remain listed after its parent turn');
    const terminal = rows[0]!;
    monitor = new TerminalMonitor(session, terminal, (chunk) => { output += chunk; }, false);
    monitor.open();
    await until(() => output.includes('AI_AGENTS_INITIAL_STDOUT'), 5000);
    assert.doesNotMatch(output, /Process exited/, 'the initial output must be visible while the process remains live');
    await until(() => output.includes('AI_AGENTS_LATE_STDOUT'), 20000);
    await until(() => output.includes('Process exited'), 20000);
    assert.match(output, /AI_AGENTS_INITIAL_STDERR/);
    assert.match(output, /AI_AGENTS_LATE_STDERR/);
    assert.ok(updates.some((update) => update.tool?.kind === 'shell' && update.tool.status !== 'running' && update.tool.exitCode === 0), 'the final command item must report exit code 0');
    console.log('RUNTIME_TERMINAL_INITIAL_OUTPUT', JSON.stringify({ backend: 'codex-app-server', model, processId: terminal.processId, itemId: terminal.itemId, initialStdout: true, lateStdout: true, stderrMarkers: true, exitCode: 0, outputBytes: Buffer.byteLength(output) }));
  } finally {
    monitor?.dispose();
    unsubscribe();
    for (const row of await session.listBackgroundTerminals?.().catch(() => []) ?? []) await session.terminateBackgroundTerminal?.(row.processId);
    await session.dispose();
    await cleanup();
  }
});

test('App Server: attached terminal receives real output and Ctrl+C interrupts the original process', { skip: !enabled, timeout: 150000 }, async () => {
  const { cwd, cleanup } = await workspace();
  const model = await preferred('codex');
  const session = await createSession(options('codex', 'app-server', cwd, model));
  let monitor: TerminalMonitor | undefined;
  let output = '';
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    const script = 'import signal,time,sys; signal.signal(signal.SIGINT,lambda s,f:(print("ATTACH_INTERRUPTED",flush=True),sys.exit(130))); print("ATTACH_READY",flush=True); time.sleep(90)';
    await session.run(`Run exactly one background process using exec_command with tty true and yield_time_ms 1000: python3 -u -c '${script}'. Return immediately with the running process ID. Do not poll, wait, write_stdin or stop it. No file changes.`, AbortSignal.timeout(90000), (update) => updates.push(update));
    const rows = await session.listBackgroundTerminals!();
    assert.equal(rows.length, 1);
    monitor = new TerminalMonitor(session, rows[0]!, (text) => { output += text; }, false);
    monitor.open();
    await until(() => output.includes('ATTACH_READY'));
    monitor.handleInput('\x03');
    await until(() => output.includes('Process exited'), 20000);
    await until(() => updates.some((update) => update.meta?.type === 'terminals' && update.meta.terminals?.length === 0));
    console.log('RUNTIME_TERMINAL_ATTACH', JSON.stringify({ model, processId: rows[0]!.processId, output: true, runtimeCancellation: true, originalProcessExited: true }));
  } finally {
    monitor?.dispose(); unsubscribe();
    for (const row of await session.listBackgroundTerminals?.().catch(() => []) ?? []) await session.terminateBackgroundTerminal?.(row.processId);
    await session.dispose(); await cleanup();
  }
});

for (const [provider, backend] of [['cursor', 'acp'], ['codex', 'app-server']] as const) {
  test(`${provider}/${backend}: real Plan revision and Build preserve the conversation`, { skip: !enabled, timeout: 300000 }, async () => {
    const { cwd, cleanup } = await workspace();
    const model = await preferred(provider);
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
