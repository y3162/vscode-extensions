import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexAppServerSession } from '../src/providers/codex-app-server.js';
import { createCursorAcpSession } from '../src/providers/cursor-acp.js';
import type { AgentUpdate } from '../src/types.js';
import { ChatController } from '../src/chat-controller.js';

async function fixture(name: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-protocol-'));
  const command = path.join(cwd, name);
  const { cp } = await import('node:fs/promises');
  await cp(path.join(__dirname, 'fixtures', name), command);
  await cp(path.join(__dirname, 'fixtures', 'real', 'runtime-090.json'), path.join(cwd, 'runtime-090.json'));
  await chmod(command, 0o755);
  return { cwd, command, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

test('Cursor ACP streams text, file diffs, and answers a permission request', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  try {
    let decision = '';
    const session = await createCursorAcpSession({
      provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command, backend: 'acp',
      interactions: {
        requestPermission: async (request) => { decision = request.title; return 'allow-once'; },
        requestPlan: async () => 'accepted',
        requestAnswers: async () => ({}),
      },
    });
    const updates: AgentUpdate[] = [];
    try {
      await session.run('NEED_PERMISSION', new AbortController().signal, (update) => updates.push(update));
      assert.equal(decision, 'npm test');
      assert.match(updates.map((update) => update.text).join('\n'), /permission:/);
      const files: AgentUpdate[] = [];
      await session.run('hello', new AbortController().signal, (update) => files.push(update));
      assert.match(files.map((update) => update.text).join('\n'), /acp answer/);
      const changedFile = files.find((update) => update.meta?.type === 'files')?.meta?.files?.[0];
      assert.ok(changedFile);
      assert.deepEqual(changedFile.preview, [
        { kind: 'remove', line: 1, text: 'old' },
        { kind: 'add', line: 1, text: 'new' },
      ]);
      assert.ok(session.setMode);
      await assert.rejects(() => session.setMode!('plan'), /mode rejected/);
      const afterMode: AgentUpdate[] = [];
      await session.run('hello', new AbortController().signal, (update) => afterMode.push(update), undefined, {
        intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: '' },
      });
      assert.match(afterMode.map((update) => update.text).join('\n'), /modes:0\/1/);
      const listed = await session.listSessions?.();
      assert.equal(listed?.[0]?.id, 'acp-session');
      await session.dispose();
      assert.equal(session.closed, true);
      const started = Date.now();
      await assert.rejects(() => session.run('again', new AbortController().signal, () => {}), /closed|exited/);
      assert.ok(Date.now() - started < 1000);
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});

test('Codex App Server streams deltas, lists threads, and returns an approval decision', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  try {
    let title = '';
    const session = await createCodexAppServerSession({
      provider: 'codex', cwd, model: 'fixture-model', storagePath: cwd, codexPath: command, backend: 'app-server',
      interactions: {
        requestPermission: async (request) => { title = request.title; return 'allow-once'; },
        requestPlan: async () => 'rejected',
        requestAnswers: async () => ({}),
      },
    });
    const updates: AgentUpdate[] = [];
    try {
      await session.run('hello app server', new AbortController().signal, (update) => updates.push(update));
      assert.match(updates.map((update) => update.text).join('\n'), /app server/);
      updates.length = 0;
      await session.run('NEED_APPROVAL', new AbortController().signal, (update) => updates.push(update));
      assert.equal(title, 'npm test');
      assert.match(updates.map((update) => update.text).join('\n'), /approved:accept/);
      const planUpdates: AgentUpdate[] = [];
      await session.run('plan please', new AbortController().signal, (update) => planUpdates.push(update), undefined, {
        intent: 'plan', mode: 'plan', selection: { provider: 'codex', cwd, model: 'fixture-model' },
      });
      assert.equal(planUpdates.some((update) => update.meta?.type === 'plan' && update.meta.plan?.source === 'assistant-text' && update.meta.plan.markdown.includes('app server')), true);
      const spawned: AgentUpdate[] = [];
      await session.run('SPAWN_AGENT', new AbortController().signal, (update) => spawned.push(update));
      const child = spawned.filter((update) => update.meta?.type === 'subagent' && update.meta.subagent?.id === 'child-thread').at(-1);
      assert.equal(child?.meta?.subagent?.status, 'completed');
      assert.match(child?.meta?.subagent?.resultPreview ?? '', /child result/);
      assert.equal(spawned.some((update) => update.role === 'assistant' && update.text.includes('child result')), false);
      assert.equal(new Set(spawned.filter((update) => update.meta?.subagent).map((update) => update.meta!.subagent!.id)).size, 1);
      assert.equal((await session.listSessions?.())?.[0]?.title, 'Fixture');
      assert.match(await session.rateLimits?.() ?? '', /12%/);
      assert.match(await session.instructions?.() ?? '', /fixture-skill/);
      assert.equal(await session.fork?.(), 'thread-2');
      assert.equal(session.rewindUnsupportedReason?.(), undefined);
      assert.equal(await session.forkBeforeTurn?.('turn-b'), 'thread-3');
      await assert.rejects(() => session.forkBeforeTurn!('missing-turn'), /no longer present/);
      await assert.rejects(() => session.run('FAIL_TURN', new AbortController().signal, () => {}), /boom/);
      await session.dispose();
      assert.equal(session.closed, true);
      const started = Date.now();
      await assert.rejects(() => session.run('again', new AbortController().signal, () => {}), /closed|exited/);
      assert.ok(Date.now() - started < 1000);
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});

test('captured App Server activities identify two children instead of wait calls', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const updates: AgentUpdate[] = [];
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    await session.run('REAL_SUBAGENTS', new AbortController().signal, (update) => updates.push(update));
    const children = new Map(updates.flatMap((update) => update.meta?.subagent ? [[update.meta.subagent.id, update.meta.subagent] as const] : []));
    assert.equal(children.size, 2);
    assert.deepEqual([...children.values()].map((item) => item.status), ['completed', 'completed']);
    assert.ok([...children.values()].every((item) => item.name.startsWith('/root/') && item.model === 'gpt-6-luna'));
    assert.ok([...children.values()].every((item) => item.resultPreview));
    assert.equal(updates.some((item) => item.role === 'assistant' && /alpha|beta/.test(item.text)), false);
  } finally { unsubscribe(); await session.dispose(); await cleanup(); }
});

test('captured ACP task requests enrich the existing running card', { timeout: 15000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const updates: AgentUpdate[] = [];
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command });
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    await session.run('REAL_TASKS', new AbortController().signal, (update) => updates.push(update));
    const children = new Map(updates.flatMap((update) => update.meta?.subagent ? [[update.meta.subagent.id, update.meta.subagent] as const] : []));
    assert.equal(children.size, 2);
    assert.ok([...children.values()].every((child) => child.agentId && child.model === 'composer-2.5-fast' && child.status === 'completed' && child.durationMs && child.background === false));
    assert.equal(new Set(updates.filter((update) => update.meta?.subagent?.status === 'running').map((update) => update.meta!.subagent!.id)).size, 2);
  } finally { unsubscribe(); await session.dispose(); await cleanup(); }
});

for (const scenario of ['BACKGROUND', 'POLL_EXIT', 'LIST_FAIL', 'TERMINATE_FAIL', 'PAGED']) {
  test(`background terminal lifecycle: ${scenario}`, { timeout: 15000 }, async () => {
    const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
    const updates: AgentUpdate[] = [];
    const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
    const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
    try {
      await session.run(scenario, new AbortController().signal, () => {});
      assert.equal(updates.at(-1)?.meta?.terminals?.length, scenario === 'PAGED' ? 2 : 1);
      if (scenario === 'LIST_FAIL') {
        await assert.rejects(session.listBackgroundTerminals!(), /unavailable/);
        assert.equal(updates.at(-1)?.meta?.terminals?.[0]?.status, 'unknown');
        assert.match(updates.at(-1)?.meta?.terminals?.[0]?.error ?? '', /unavailable/);
      } else if (scenario === 'TERMINATE_FAIL') {
        await assert.rejects(session.terminateBackgroundTerminal!('proc-1'), /not terminated/);
        assert.equal((await session.listBackgroundTerminals!()).length, 1);
      } else if (scenario === 'PAGED') {
        await session.terminateBackgroundTerminal!('proc-1');
        assert.deepEqual((await session.listBackgroundTerminals!()).map((row) => row.processId), ['proc-2']);
      } else {
        const deadline = Date.now() + 6000;
        while (!updates.some((item) => item.meta?.terminals?.length === 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(updates.some((item) => item.meta?.terminals?.length === 0), 'the empty list must be delivered without a new parent turn');
        if (scenario === 'BACKGROUND') {
          const output = updates.find((item) => item.tool?.exitCode === 0);
          assert.match(output?.text ?? '', /stdout done\nstderr done/);
          assert.equal(output?.tool?.status, 'completed');
        }
      }
      unsubscribe();
      const count = updates.length;
      await session.dispose();
      assert.equal(updates.length, count);
    } finally { await session.dispose(); await cleanup(); }
  });
}

test('App Server exit after turn/start releases the turn waiter', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  try { await assert.rejects(session.run('EXIT_AFTER_START', new AbortController().signal, () => {}), /exited/); }
  finally { await session.dispose(); await cleanup(); }
});

test('spawn completion, child failure, interruption, and unknown activity remain distinct', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  const updates: AgentUpdate[] = [];
  try {
    await session.run('CHILD_FAILURES', new AbortController().signal, (update) => updates.push(update));
    const children = updates.flatMap((update) => update.meta?.subagent ? [update.meta.subagent] : []);
    assert.equal(children.filter((child) => child.id === 'child-error')[1]?.status, 'running', 'a completed spawn call does not complete its child');
    const final = new Map(children.map((child) => [child.id, child.status]));
    assert.deepEqual([...final.values()], ['error', 'cancelled', 'unknown']);
    assert.equal(final.has('spawn-call'), false);
  } finally { await session.dispose(); await cleanup(); }
});

test('Ctrl+C cancels only a currently listed runtime terminal and rejects stale handles', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  try {
    await session.run('PAGED', new AbortController().signal, () => {});
    await assert.rejects(session.interruptBackgroundTerminal!('not-a-terminal'), /終了/);
    assert.equal((await session.listBackgroundTerminals!()).length, 2);
    await session.interruptBackgroundTerminal!('proc-1');
    assert.deepEqual((await session.listBackgroundTerminals!()).map((row) => row.processId), ['proc-2']);
    await assert.rejects(session.interruptBackgroundTerminal!('proc-1'), /終了/);
  } finally { await session.dispose(); await cleanup(); }
});

test('a silent child is reconciled through public thread/read after its parent ends', { timeout: 10000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture', storagePath: cwd, codexPath: command });
  const updates: AgentUpdate[] = [];
  const unsubscribe = session.subscribeBackgroundUpdates!((update) => updates.push(update));
  try {
    await session.run('SILENT_CHILD', new AbortController().signal, () => {});
    assert.equal(updates.find((update) => update.meta?.subagent)?.meta?.subagent?.status, 'running');
    const deadline = Date.now() + 6000;
    while (!updates.some((update) => update.meta?.subagent?.status === 'cancelled') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(updates.some((update) => update.meta?.subagent?.id === 'silent-child' && update.meta.subagent.status === 'cancelled'));
  } finally { unsubscribe(); await session.dispose(); await cleanup(); }
});

test('captured native move_path identifies the destination and preserves the source baseline', { timeout: 10000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(path.join(cwd, 'a.txt'), 'alpha\n');
  const controller = new ChatController({ provider: 'codex', cwd, model: 'fixture' }, async (selection) => createCodexAppServerSession({ ...selection, storagePath: cwd, codexPath: command }), () => {});
  try {
    await controller.send('REAL_RENAME');
    const changes = controller.snapshot().changes;
    assert.equal(changes.length, 1, 'native rename and Git delete/add must not create duplicate rows');
    assert.equal(changes[0]?.path, path.join(cwd, 'b.txt'));
    assert.equal(changes[0]?.oldPath, path.join(cwd, 'a.txt'));
    assert.equal(changes[0]?.kind, 'rename');
    assert.equal(changes[0]?.previousText, 'alpha\n');
    assert.equal(changes[0]?.additions, 1);
    assert.equal(changes[0]?.deletions, 1);
    assert.match(changes[0]?.diff ?? '', /-alpha\n\+beta/);
  } finally { await controller.dispose(); await cleanup(); }
});

test('editing an earlier App Server prompt restores its per-turn file checkpoint and branches history', { timeout: 20000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  execFileSync('git', ['init', '-q'], { cwd });
  const journalDirectory = path.join(cwd, 'journal');
  const controller = new ChatController({ provider: 'codex', cwd, model: 'fixture' }, async (selection, context) => createCodexAppServerSession({
    ...selection, storagePath: cwd, codexPath: command, resumeId: context?.resumeId,
  }), () => {}, {
    journalDirectory,
    conversationId: () => 'conversation-1',
    enabled: () => true,
    flush: async () => {},
  });
  try {
    await controller.send('touch a.txt');
    await controller.send('write abcd into a.txt');
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'abcd');
    await controller.send('write later into a.txt');
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'later');
    const turns = controller.snapshot().turns;
    assert.equal(turns[0]?.fileCheckpoint?.status, 'captured');
    assert.equal(turns[1]?.fileCheckpoint?.status, 'captured');
    assert.equal(turns[2]?.fileCheckpoint?.status, 'captured');
    const preview = await controller.previewRewind(turns[1]!.id);
    assert.deepEqual(preview.files, ['a.txt']);
    assert.equal(preview.removedTurns, 2);
    await controller.rewindAndSend(turns[1]!.id, 'write 1234 into a.txt', { displayText: 'write 1234 into a.txt' });
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), '1234');
    assert.deepEqual(controller.snapshot().messages.filter((message) => message.role === 'user').map((message) => message.text), [
      'touch a.txt', 'write 1234 into a.txt',
    ]);
    assert.equal(controller.sessionId(), 'thread-2');
    assert.equal(controller.snapshot().turns.length, 2);
  } finally { await controller.dispose(); await cleanup(); }
});


test('ACP preserves repeated deltas and a final answer repeated after a tool on every turn', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command });
  try {
    for (let turn = 0; turn < 3; turn++) {
      const updates: AgentUpdate[] = [];
      await session.run('REPEATED_FINAL', new AbortController().signal, (update) => updates.push(update));
      const messages = new Map(updates.filter((update) => update.role === 'assistant').map((update) => [update.id, update]));
      assert.deepEqual([...messages.values()].map((message) => message.text), ['done', 'done done done']);
      assert.equal([...messages.values()].at(-1)?.final, true);
    }
  } finally { await session.dispose(); await cleanup(); }
});


test('ACP replay keeps repeated final answers distinct across tools and restored turns', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command, resumeId: 'repeat-history' });
  try {
    const replay: import('../src/types.js').ChatMessage[] = [];
    await session.loadTranscript?.((message) => replay.push(message));
    const answers = replay.filter((message) => message.role === 'assistant' && message.text === 'done');
    assert.equal(answers.length, 4);
    assert.equal(new Set(answers.map((message) => message.id)).size, 4);
    assert.deepEqual(answers.map((message) => message.final === true), [false, true, false, true]);
  } finally { await session.dispose(); await cleanup(); }
});


test('ACP applies only advertised canonical model variants and validates backend acknowledgment', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command });
  const selection = { provider: 'cursor' as const, cwd, model: 'composer-2.5', modelParams: [{ id: 'fast', value: 'true' }] };
  try {
    await session.setModel!(selection);
    await assert.rejects(async () => session.setModel!({ ...selection, modelParams: [{ id: 'fast', value: 'false' }] }), /not advertised/);
    await assert.rejects(async () => session.setModel!({ ...selection, model: 'missing' }), /not advertised/);
    const updates: AgentUpdate[] = [];
    await session.run('REPEATED_FINAL', new AbortController().signal, (update) => updates.push(update), undefined, {intent:'chat',mode:'agent',selection});
    assert.equal(updates.filter((update) => update.role === 'assistant').at(-1)?.text, 'done done done');
  } finally { await session.dispose(); await cleanup(); }
});


test('a rejected ACP turn mode releases its live callback before later idle events', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command });
  const updates: AgentUpdate[] = [];
  try {
    await assert.rejects(session.run('plan', new AbortController().signal, (update) => updates.push(update), undefined, {intent:'plan',mode:'plan',selection:{provider:'cursor',cwd,model:''}}), /mode rejected/);
    await session.setMode!('ask');
    assert.equal(updates.length, 0);
    const replay: string[] = [];
    await session.loadTranscript?.((message) => replay.push(message.text));
    assert.deepEqual(replay, ['idle mode update']);
  } finally { await session.dispose(); await cleanup(); }
});


for (const [model, expected] of [['rejected', /model refused/], ['no-ack', /did not acknowledge/]] as const) {
  test(`ACP closes an uncertain model connection: ${model}`, { timeout: 5000 }, async () => {
    const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
    const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', storagePath: cwd, agentPath: command });
    try {
      await assert.rejects(async () => session.setModel!({provider:'cursor',cwd,model}), expected);
      assert.equal(session.closed, true);
      await assert.rejects(session.run('must not send', new AbortController().signal, () => {}), /closed/);
    } finally { await session.dispose(); await cleanup(); }
  });
}

test('ACP resume reapplies a requested advertised model instead of trusting stale UI selection', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  try {
    const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: 'composer-2.5', storagePath: cwd, agentPath: command, resumeId:'old' });
    try {
      // No-ack is intentionally advertised but not acknowledged. Initial selection must validate too.
      await assert.rejects(createCursorAcpSession({ provider:'cursor',cwd,model:'no-ack',storagePath:cwd,agentPath:command,resumeId:'old' }), /did not acknowledge/);
      assert.equal(session.closed, false);
    } finally { await session.dispose(); }
  } finally { await cleanup(); }
});

test('ACP resume restores Agent mode even when the backend saved Plan mode', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-acp.cjs');
  const session = await createCursorAcpSession({ provider: 'cursor', cwd, model: '', mode: 'agent', storagePath: cwd, agentPath: command, resumeId: 'saved-plan' });
  try {
    const updates: AgentUpdate[] = [];
    await session.run('REPORT_MODE', new AbortController().signal, (update) => updates.push(update), undefined, {
      intent: 'chat', mode: 'agent', selection: { provider: 'cursor', cwd, model: '' },
    });
    assert.equal(updates.filter((update) => update.role === 'assistant').at(-1)?.text, 'agent');
  } finally { await session.dispose(); await cleanup(); }
});

test('App Server history retains the backend final answer phase', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture-model', storagePath: cwd, codexPath: command, resumeId: 'history-final' });
  try {
    const replay: import('../src/types.js').ChatMessage[] = [];
    await session.loadTranscript?.((message) => replay.push(message));
    assert.deepEqual(replay.map((message) => [message.text, message.final === true]), [
      ['Checking files', false], ['Backend final answer', true],
    ]);
    assert.ok(replay.every((message) => message.backendTurnId === 'saved-turn'));
  } finally { await session.dispose(); await cleanup(); }
});

test('App Server retains output received before the background process ID is advertised', { timeout: 5000 }, async () => {
  const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
  const session = await createCodexAppServerSession({ provider: 'codex', cwd, model: 'fixture-model', storagePath: cwd, codexPath: command });
  try {
    await session.run('EARLY_TERMINAL_OUTPUT', new AbortController().signal, () => {});
    const terminals = await session.listBackgroundTerminals!();
    assert.equal(terminals[0]?.processId, 'early-process');
    assert.equal(terminals[0]?.output, 'EARLY_READY\n');
  } finally { await session.dispose(); await cleanup(); }
});


for (const sandbox of ['workspace-write', 'read-only', 'danger-full-access']) {
  test(`App Server Plan enforces read-only and Build restores the exact configured policy: ${sandbox}`, { timeout: 5000 }, async () => {
    const { cwd, command, cleanup } = await fixture('mock-app-server.cjs');
    const session = await createCodexAppServerSession({ provider:'codex',cwd,model:'fixture-model',storagePath:cwd,codexPath:command,sandbox,approval:'on-request',network:true,additionalDirectories:['/tmp/additional'] });
    try {
      for (const mode of ['plan','agent','plan','agent'] as const) {
        const updates: AgentUpdate[]=[];
        await session.run('SECURITY_POLICY',new AbortController().signal,(update)=>updates.push(update),undefined,{intent:mode==='plan'?'plan':'build',mode,selection:{provider:'codex',cwd,model:'fixture-model'}});
        const actual = JSON.parse(updates.filter((update)=>update.role==='assistant').at(-1)!.text);
        if (mode === 'plan') assert.deepEqual(actual,{sandbox:{type:'readOnly',networkAccess:false},approval:'never'});
        else assert.deepEqual(actual,{sandbox:sandbox==='read-only'?{type:'readOnly',networkAccess:false}:sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:[cwd,'/tmp/additional'],networkAccess:true,excludeSlashTmp:true,excludeTmpdirEnvVar:true},approval:'on-request'});
      }
    } finally { await session.dispose(); await cleanup(); }
  });
}
