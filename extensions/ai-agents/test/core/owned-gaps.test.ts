import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from '../../src/capabilities.js';
import { captureBaseline, gitApplyReverse, isInsideWorkspace, mergeFileChanges, revertChange } from '../../src/change-review.js';
import { applyTextStats, captureGitBaselines, readWorkspaceText, refreshChangeStats } from '../../src/change-tracker.js';
import { builtinCommand, expandPrompt, parseFrontmatter, resolveInside, suggestionToken, type SlashCommand } from '../../src/context-text.js';
import { countUnifiedDiff, extensionBadge, lineChangeCounts, normalizeChangeKind, parseUnifiedDiff, previewTextDiff, previewUnifiedDiff, previousTextFromDiff } from '../../src/diff-stats.js';
import { HistoryStore, type SavedConversation } from '../../src/history-store.js';
import { sanitizeImages, writeImageFiles } from '../../src/images.js';
import { baseModelLabel, selectBaseModel } from '../../src/model-selection.js';
import { annotateParameter, catalogIsCurrent, filterModels, formatToken, isToggleOn, orderedParameters, parameterRole, reconcileModelParams, toCatalogModel, toggleOnValue } from '../../src/model-settings.js';
import { applyPlanTodos, beginPlanning, buildPrompt, cloneSelection, commitDraft, finishBuild, inferIntent, planningFailed, requestBuild, setBuildSelection, stageDraft } from '../../src/plan-state.js';
import { mergeRegistrySessions, sessionTitle, upsertSession } from '../../src/session-index.js';
import { ChatController } from '../../src/chat-controller.js';
import { SessionRegistry } from '../../src/session-registry.js';
import { TerminalMonitor } from '../../src/terminal-monitor.js';
import { classifyTool, toolStatus } from '../../src/tool-kind.js';
import { buildTurnRewindPlan, discardTurnRewindJournal, prepareTurnRewindJournal, readSafeWorkspaceFile, readTurnRewindJournal, restoreTurnRewindFiles, rollbackTurnRewindJournal, workspaceRelativePath } from '../../src/turn-rewind.js';
import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';
import { usageDifference, usageText } from '../../src/usage.js';
import { buildShell, countDiff, presentChange, toViewMessage, type ShellSource } from '../../src/view-state.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

function selection(cwd = '/work'): Selection {
  return { provider: 'codex', cwd, model: 'fixture' };
}

function chatState(cwd = '/work', messages: ChatState['messages'] = [{ id: 'm1', role: 'user', text: 'hello' }]): ChatState {
  return {
    selection: selection(cwd), busy: false, messages, queue: [], status: 'idle', usage: null,
    changes: [], todos: [], sessions: [], autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [],
  };
}

function saved(id: string, state = chatState()): SavedConversation {
  return { version: 1, id, sessionId: `session-${id}`, updatedAt: '2026-10-17T00:00:00.000Z', controls: defaultControls('codex', 'sdk'), state };
}

function planDocument(extra: Partial<PlanState['current']> = {}) {
  return {
    id: 'plan-1', revision: 1, markdown: 'Do the work', todos: [{ content: 'step', status: 'pending' }],
    source: 'assistant-text' as const, createdAt: 1, name: 'Name', overview: 'Overview', files: ['a.ts'], ...extra,
  };
}

function readyPlan(phase: PlanState['phase'] = 'ready'): PlanState {
  return { phase, revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: 'Do the work', name: 'Name' }], current: planDocument(), build: { selection: selection(), label: 'Fixture' } };
}

function capturedTurn(id: string, root: string, files: TurnFileSnapshot[], extra: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id, backendTurnId: `backend-${id}`, startedAt: 1, endedAt: 2, status: 'completed', waitMs: 0,
    mode: 'agent', model: 'fixture', intent: 'chat', planBefore: emptyPlanState(), todosBefore: [],
    fileCheckpoint: { status: 'captured', workspaceRoot: root, files }, ...extra,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('history load rejects non-ENOENT failures, invalid records, and still reads a valid sibling', async () => {
  const root = await tempDir('ai-agents-history-load-');
  const outside = await tempDir('ai-agents-history-outside-');
  const outsideFile = path.join(outside, 'untouched.txt');
  await writeFile(outsideFile, 'keep', { mode: 0o640 });
  try {
    const valid = saved('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await writeFile(path.join(root, `${valid.id}.json`), JSON.stringify(valid), { mode: 0o600 });
    const broken: Array<[string, unknown]> = [
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { ...valid, version: 2, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
      ['cccccccc-cccc-cccc-cccc-cccccccccccc', { ...valid, id: 'not-the-file-name' }],
      ['dddddddd-dddd-dddd-dddd-dddddddddddd', { ...valid, id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', state: { ...valid.state, selection: undefined } }],
      ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', { ...valid, id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', state: { ...valid.state, messages: 'nope' } }],
      ['ffffffff-ffff-ffff-ffff-ffffffffffff', { ...valid, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', state: { ...valid.state, turns: null } }],
      ['11111111-1111-1111-1111-111111111111', { ...valid, id: '11111111-1111-1111-1111-111111111111', controls: { ...valid.controls, backend: undefined } }],
      ['22222222-2222-2222-2222-222222222222', { ...valid, id: '22222222-2222-2222-2222-222222222222', updatedAt: 1 }],
      ['33333333-3333-3333-3333-333333333333', { ...valid, id: '33333333-3333-3333-3333-333333333333', state: { ...valid.state, selection: { provider: 'codex', model: 'm' } } }],
      ['44444444-4444-4444-4444-444444444444', { ...valid, id: '44444444-4444-4444-4444-444444444444', state: { ...valid.state, selection: { provider: 'other', cwd: '/work', model: 'm' } } }],
      ['55555555-5555-5555-5555-555555555555', { ...valid, id: '55555555-5555-5555-5555-555555555555', controls: { ...valid.controls, backend: 'other' } }],
      ['66666666-6666-6666-6666-666666666666', { ...valid, id: '66666666-6666-6666-6666-666666666666', state: { ...valid.state, terminals: 'nope' } }],
      ['77777777-7777-7777-7777-777777777777', { ...valid, id: '77777777-7777-7777-7777-777777777777', state: { ...valid.state, plan: undefined } }],
      ['88888888-8888-8888-8888-888888888888', { ...valid, id: '88888888-8888-8888-8888-888888888888', state: { ...valid.state, messages: [{ id: 'm', role: 'nope', text: 'x' }] } }],
    ];
    for (const [id, value] of broken) await writeFile(path.join(root, `${id}.json`), JSON.stringify(value), { mode: 0o600 });
    await writeFile(path.join(root, 'notes.txt'), 'ignore me');
    const store = new HistoryStore(root);
    await store.load();
    assert.equal(store.errors.length, broken.length);
    assert.equal(store.get(valid.id)?.state.messages[0]?.text, 'hello');
    assert.equal(store.get(valid.sessionId!)?.id, valid.id);
    assert.equal(store.get('missing'), undefined);
    assert.equal(store.summaries().find((item) => item.conversationId === valid.id)?.title, 'hello');
    const untitled = saved('99999999-9999-9999-9999-999999999999', chatState('/work', []));
    await writeFile(path.join(root, `${untitled.id}.json`), JSON.stringify(untitled));
    const titled = new HistoryStore(root);
    await titled.load();
    assert.equal(titled.summaries().find((item) => item.conversationId === untitled.id)?.title, 'Chat');
    for (const [id] of broken) assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8') !== '', true);
    const blocked = path.join(root, 'not-a-directory');
    await writeFile(blocked, 'file');
    await assert.rejects(new HistoryStore(blocked).load(), { code: 'ENOTDIR' });
    const missing = new HistoryStore(path.join(root, 'missing-dir'));
    await missing.load();
    assert.deepEqual(missing.summaries(), []);
    await chmod(root, 0o000);
    await assert.rejects(new HistoryStore(root).load(), { code: 'EACCES' });
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    assert.equal(await readFile(outsideFile, 'utf8'), 'keep');
    assert.equal((await stat(outsideFile)).mode & 0o777, 0o640);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a superseded 500ms history debounce writes only the latest snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await tempDir('ai-agents-history-debounce-');
  try {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const store = new HistoryStore(root);
    const busy = (text: string): SavedConversation => ({ ...saved(id), state: { ...chatState('/work', [{ id: 'm', role: 'user', text }]), busy: true } });
    store.schedule(busy('first'));
    t.mock.timers.tick(499);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT');
    store.schedule(busy('second'));
    t.mock.timers.tick(100);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT');
    t.mock.timers.tick(400);
    const tails = (store as unknown as { tails: Map<string, Promise<void>> }).tails;
    await Promise.all([...tails.values()]);
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'second');
    store.schedule({ ...saved(id), state: chatState('/work', [{ id: 'm', role: 'user', text: 'immediate' }]) });
    await Promise.all([...tails.values()]);
    t.mock.timers.tick(500);
    await Promise.all([...tails.values()]);
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'immediate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('history flush and clear keep the previous file when the write or unlink fails', async () => {
  const root = await tempDir('ai-agents-history-flush-');
  try {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const failures: unknown[] = [];
    const store = new HistoryStore(root, (error) => failures.push(error));
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'original' }])));
    store.schedule(saved(other));
    await store.flush();
    const original = await readFile(path.join(root, `${id}.json`), 'utf8');
    await chmod(root, 0o500);
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'replacement' }])));
    await assert.rejects(store.flush(), { code: 'EACCES' });
    await chmod(root, 0o700);
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8'), original);
    assert.equal(failures.length > 0, true);
    assert.equal(store.get(id)?.state.messages[0]?.text, 'replacement');
    await store.flush();
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8')).state.messages[0].text, 'replacement');

    const destination = path.join(root, `${id}.json`);
    await rm(destination);
    await mkdir(destination);
    store.schedule(saved(id, chatState('/work', [{ id: 'm', role: 'user', text: 'after rename failure' }])));
    await assert.rejects(store.flush(), (error: NodeJS.ErrnoException) => error.code === 'EISDIR' || error.code === 'EPERM');
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
    await rm(destination, { recursive: true });
    await store.flush();
    assert.equal(JSON.parse(await readFile(destination, 'utf8')).state.messages[0].text, 'after rename failure');

    const clean = new HistoryStore(root);
    await clean.load();
    const file = path.join(root, `${other}.json`);
    await rm(file);
    await mkdir(file);
    await assert.rejects(clean.clear(other), (error: NodeJS.ErrnoException) => error.code === 'EPERM' || error.code === 'EISDIR');
    assert.equal(clean.get(other)?.id, other);
    assert.equal((await lstat(file)).isDirectory(), true);
    await rm(file, { recursive: true, force: true });
    await clean.clear();
    assert.equal(clean.get(id), undefined);
    assert.equal(clean.get(other), undefined);
    await assert.rejects(readFile(path.join(root, `${id}.json`), 'utf8'), { code: 'ENOENT' });
    await clean.clear(id);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('plan helpers cover empty todos, build selection, and planning versus building intent', () => {
  const idle = emptyPlanState();
  assert.equal(applyPlanTodos(idle, []), idle);
  assert.equal(applyPlanTodos(idle, [{ content: 'x', status: 'pending' }]), idle);
  const drafted = stageDraft(idle, { markdown: '  Plan body  ', name: 'Named', overview: 'Why', files: ['a.ts'], todos: [{ content: 'old', status: 'pending' }], source: 'assistant-text' });
  assert.equal(drafted.draft?.markdown, 'Plan body');
  assert.equal(drafted.draft?.name, 'Named');
  assert.deepEqual(applyPlanTodos(drafted, []).draft?.todos, drafted.draft?.todos);
  assert.equal(applyPlanTodos(drafted, [{ content: 'new', status: 'completed' }]).draft?.todos[0]?.content, 'new');
  assert.equal(stageDraft(idle, { markdown: '   ', source: 'assistant-text' }), idle);
  const currentOnly = { ...idle, current: planDocument() };
  assert.equal(applyPlanTodos(currentOnly, [{ content: 'kept', status: 'pending' }]).current?.todos[0]?.content, 'kept');
  assert.equal(setBuildSelection(idle, selection()), idle);
  const noCurrent = { ...readyPlan(), current: undefined };
  assert.equal(setBuildSelection(noCurrent, selection()), noCurrent);
  const selected = setBuildSelection(readyPlan(), { ...selection(), model: 'other', modelParams: [{ id: 'effort', value: 'high' }] }, 'Other');
  assert.equal(selected.build?.label, 'Other');
  assert.equal(selected.build?.selection.model, 'other');
  assert.equal(setBuildSelection(readyPlan(), selection()).build?.label, undefined);
  assert.equal(inferIntent('agent', readyPlan('planning')), 'chat');
  assert.equal(inferIntent('plan', readyPlan('planning')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('building')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('idle')), 'plan');
  assert.equal(inferIntent('plan', readyPlan('ready')), 'revise');
  assert.equal(inferIntent('plan', readyPlan('implemented')), 'revise');
  assert.equal(inferIntent('plan', readyPlan('revising')), 'revise');
  const building = requestBuild(readyPlan('building'), 'plan-1', 1, selection());
  assert.deepEqual(building, { error: '実装はすでに始まっています。' });
  assert.equal(beginPlanning(readyPlan('building')).phase, 'building');
  const revising = beginPlanning(readyPlan('implemented'));
  assert.equal(revising.phase, 'revising');
  assert.equal(revising.revisionBasePhase, 'implemented');
  assert.equal(planningFailed(revising).phase, 'implemented');
  assert.equal(planningFailed({ phase: 'planning', revisions: [] }).phase, 'idle');
  assert.equal(finishBuild(idle, 'completed').phase, 'idle');
  assert.equal(finishBuild(readyPlan('building'), 'cancelled').phase, 'ready');
  assert.equal(commitDraft(idle, selection()).error, '計画は作成されませんでした。');
  const committed = commitDraft(drafted, { ...selection(), modelParams: [{ id: 'effort', value: 'low' }] }, 'thread');
  assert.equal(committed.phase, 'ready');
  assert.equal(committed.current?.sessionId, 'thread');
  assert.equal(committed.build?.selection.modelParams?.[0]?.value, 'low');
  committed.build!.selection.modelParams![0]!.value = 'mutated';
  assert.equal(drafted.draft?.markdown, 'Plan body');
  const prompt = buildPrompt({ ...planDocument(), todos: [], name: undefined, overview: undefined });
  assert.equal(prompt.includes('To-dos'), false);
  assert.equal(prompt.includes('# Name'), false);
  assert.deepEqual(cloneSelection(selection()), selection());
  const cloned = cloneSelection({ ...selection(), modelParams: [{ id: 'effort', value: 'max' }] });
  cloned.modelParams![0]!.value = 'changed';
  assert.equal(cloned.modelParams?.[0]?.value, 'changed');
});

test('normalizeControls drops unsupported sandbox, search, network, and directories per backend', () => {
  const codex = capabilitiesFor('codex', 'sdk');
  assert.equal(codex.compact, false);
  assert.equal(codex.rateLimits, false);
  assert.equal(codex.modelSettings, 'new-session');
  assert.equal(codex.webSearch.some((item) => item.id === 'cached'), true);
  assert.equal(capabilitiesFor('cursor', 'sdk').networkToggle, false);
  assert.equal(capabilitiesFor('cursor', 'acp').additionalDirectories, false);
  assert.equal(defaultControls('cursor', 'acp').sandbox, 'enabled');
  assert.equal(defaultControls('codex', 'app-server').sandbox, 'workspace-write');
  const cursor = normalizeControls('cursor', { ...defaultControls('cursor', 'acp'), mode: 'ask', sandbox: 'danger-full-access', approval: 'on-request', network: true, webSearch: 'live', additionalDirectories: ['/tmp'] });
  assert.equal(cursor.mode, 'ask');
  assert.equal(cursor.sandbox, 'enabled');
  assert.equal(cursor.approval, 'never');
  assert.equal(cursor.network, false);
  assert.equal(cursor.webSearch, '');
  assert.deepEqual(cursor.additionalDirectories, []);
  const kept = normalizeControls('codex', { ...defaultControls('codex', 'app-server'), mode: 'plan', sandbox: 'read-only', approval: 'on-request', webSearch: 'cached', network: true, additionalDirectories: ['/workspace/extra'] });
  assert.equal(kept.mode, 'plan');
  assert.equal(kept.sandbox, 'read-only');
  assert.equal(kept.approval, 'on-request');
  assert.equal(kept.webSearch, 'cached');
  assert.equal(kept.network, true);
  assert.deepEqual(kept.additionalDirectories, ['/workspace/extra']);
  const invalid = normalizeControls('codex', { ...defaultControls('codex', 'sdk'), mode: 'ask' as AgentControls['mode'], sandbox: 'enabled', approval: 'on-request', webSearch: 'nope' });
  assert.equal(invalid.mode, 'agent');
  assert.equal(invalid.sandbox, 'workspace-write');
  assert.equal(invalid.approval, 'never');
  assert.equal(invalid.webSearch, '');
});

test('image sanitizing enforces mime, base64, name, count, and size boundaries before writing', async () => {
  assert.deepEqual(sanitizeImages(undefined), []);
  assert.deepEqual(sanitizeImages(null), []);
  assert.throws(() => sanitizeImages('nope'), /画像の形式が不正です/);
  assert.throws(() => sanitizeImages([null]), /画像の形式が不正です/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: '=' }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: '***' }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: 42 }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'text/plain', data: Buffer.from('a').toString('base64') }]), /5MB/);
  const exact = Buffer.alloc(5 * 1024 * 1024, 1);
  const over = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  const one = sanitizeImages([{ mimeType: 'image/jpg', data: exact.toString('base64'), name: `${'n'.repeat(121)}.png` }]);
  assert.equal(one[0]?.mimeType, 'image/jpeg');
  assert.equal(one[0]?.name?.length, 120);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: over.toString('base64') }]), /5MB/);
  const four = [0, 1, 2, 3].map((index) => ({ mimeType: index === 1 ? 'image/jpeg' : index === 2 ? 'image/gif' : index === 3 ? 'image/webp' : 'image/png', data: Buffer.from(`img${index}`).toString('base64'), name: index === 0 ? '' : `f${index}` }));
  assert.equal(sanitizeImages(four).length, 4);
  assert.equal(sanitizeImages(four)[0]?.name, undefined);
  assert.throws(() => sanitizeImages([...four, four[0]!]), /4枚まで/);
  assert.deepEqual(await writeImageFiles([]), []);
  const paths = await writeImageFiles(sanitizeImages(four));
  try {
    assert.deepEqual(paths.map((file) => path.extname(file)), ['.png', '.jpg', '.gif', '.webp']);
    assert.equal(await readFile(paths[1]!, 'utf8'), 'img1');
  } finally { await rm(path.dirname(paths[0]!), { recursive: true, force: true }); }
});

test('usage deltas omit one-sided fields and never invent a negative total', () => {
  const reasoning = usageDifference({ inputTokens: 2, outputTokens: 2, reasoningTokens: 4 }, { inputTokens: 1, outputTokens: 1 });
  assert.equal(reasoning?.inputTokens, 1);
  assert.equal(reasoning?.outputTokens, 1);
  assert.equal(Object.hasOwn(reasoning!, 'reasoningTokens'), false);
  const mixed = usageDifference({ inputTokens: 5, outputTokens: 4, cachedInputTokens: 1 }, { inputTokens: 2, outputTokens: 1, totalTokens: 9 });
  assert.equal(mixed?.inputTokens, 3);
  assert.equal(Object.hasOwn(mixed!, 'cachedInputTokens'), false);
  assert.equal(Object.hasOwn(mixed!, 'totalTokens'), false);
  const partial = usageDifference({ inputTokens: undefined as unknown as number, outputTokens: 2 }, { inputTokens: 1, outputTokens: 1 });
  assert.equal(partial?.outputTokens, 1);
  assert.equal(partial?.inputTokens, undefined);
  assert.equal(usageDifference({ inputTokens: 1, outputTokens: 1, totalTokens: 1 }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }), undefined);
  assert.equal(usageText(undefined), '未取得 / Not reported');
  assert.match(usageText({ inputTokens: 1000, outputTokens: 0 }), /Input 1,000/);
  assert.match(usageText({ inputTokens: 1, outputTokens: 2, totalTokens: undefined }, 'missing'), /Total —/);
});

test('secret redaction covers assignment forms, short keys, and jwt-shaped tokens', () => {
  assert.equal(redactSecrets('api_key: super-secret'), 'api_key=[redacted]');
  assert.equal(redactSecrets('Authorization: Bearer abc.def'), 'Authorization=[redacted] abc.def');
  assert.equal(redactSecrets('bearer=abc.def'), 'bearer=[redacted]');
  assert.equal(redactSecrets('password=hunter2 token=abc'), 'password=[redacted] token=[redacted]');
  assert.equal(redactSecrets('sk-1234567'), 'sk-1234567');
  assert.equal(redactSecrets('sk-12345678'), 'sk-[redacted]');
  assert.equal(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue'), '[redacted]');
  assert.equal(errorMessage(new Error('secret=value')), 'secret=[redacted]');
  assert.equal(errorMessage('plain'), 'plain');
});

test('tool classification and status cover task, subagent, and exit boundaries', () => {
  assert.equal(classifyTool('Git'), 'git');
  assert.equal(classifyTool('run', 'powershell'), 'shell');
  assert.equal(classifyTool('search', 'files'), 'search');
  assert.equal(classifyTool('Read', 'file.ts'), 'read');
  assert.equal(classifyTool('patch', 'file.ts'), 'edit');
  assert.equal(classifyTool('mcp_server'), 'mcp');
  assert.equal(classifyTool('Task'), 'subagent');
  assert.equal(classifyTool('launch', 'subagent'), 'subagent');
  assert.equal(classifyTool('custom'), 'other');
  assert.equal(toolStatus('completed', 0), 'completed');
  assert.equal(toolStatus('completed', 1), 'error');
  assert.equal(toolStatus('FAILED'), 'error');
  assert.equal(toolStatus('incomplete'), 'error');
  assert.equal(toolStatus('cancelled'), 'error');
  assert.equal(toolStatus('in_progress'), 'running');
  assert.equal(toolStatus('pending'), 'running');
  assert.equal(toolStatus(undefined), 'completed');
});

test('model selection omits empty params and keeps an alias identity', () => {
  const current: Selection = { provider: 'cursor', cwd: '/work', model: 'alias', modelParams: [{ id: 'effort', value: 'high' }] };
  const same = selectBaseModel({ id: 'base', label: 'Base', aliases: ['alias'], parameters: [{ id: 'effort', label: 'Effort', values: [{ value: 'high', label: 'High' }] }] }, current);
  assert.equal(same.model, 'alias');
  assert.equal(same.modelParams?.[0]?.value, 'high');
  const switched = selectBaseModel({ id: 'other', label: 'Other' }, current);
  assert.equal(switched.model, 'other');
  assert.equal(switched.modelParams, undefined);
  assert.equal(baseModelLabel('Model — High 1M'), 'Model');
  assert.equal(baseModelLabel('Model'), 'Model');
  assert.equal(baseModelLabel(' — High'), ' — High');
  assert.equal(baseModelLabel(''), '');
});

test('model settings order toggles, reconcile fallbacks, and catalog fields', () => {
  const fast = { id: 'fast', label: 'fast', values: [{ value: 'off', label: 'off' }, { value: 'YES', label: 'YES' }] };
  const effort = { id: 'reasoning_effort', label: 'reasoning_effort', values: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }] };
  const context = { id: 'context_size', label: 'Window', values: [{ value: '1.5k', label: '1.5k' }] };
  const ordered = orderedParameters([effort, fast, context]);
  assert.deepEqual(ordered.map((item) => item.id), ['fast', 'reasoning_effort']);
  assert.equal(ordered[0]?.presentation, 'toggle');
  assert.equal(parameterRole('modelReasoningEffort'), 'effort');
  assert.equal(parameterRole('context'), 'context');
  assert.equal(parameterRole('fast'), 'fast');
  assert.equal(parameterRole('temperature'), 'other');
  assert.equal(formatToken('2m'), '2M');
  assert.equal(isToggleOn(undefined), false);
  assert.equal(isToggleOn('YES'), true);
  assert.equal(isToggleOn('no'), false);
  assert.equal(toggleOnValue([{ value: 'off' }, { value: 'YES' }]), 'YES');
  assert.equal(toggleOnValue([{ value: 'off' }]), undefined);
  assert.equal(annotateParameter({ id: 'solo', label: 'Solo', values: [{ value: 'only', label: 'only' }] }), undefined);
  const model: AgentModel = {
    id: 'm', label: 'M', description: 'desc', aliases: ['alias'], isDefault: true,
    parameters: [effort, fast],
    defaultParams: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'YES' }],
  };
  const catalog = toCatalogModel(model);
  assert.equal(catalog.description, 'desc');
  assert.deepEqual(catalog.aliases, ['alias']);
  assert.equal(catalog.isDefault, true);
  assert.equal(toCatalogModel({ id: 'bare', label: 'Bare' }).description, undefined);
  assert.equal(reconcileModelParams({ id: '', label: '' }, [], 'codex'), undefined);
  assert.equal(reconcileModelParams({ id: 'bare', label: 'Bare' }, undefined, 'codex'), undefined);
  assert.deepEqual(reconcileModelParams({ id: 'bare', label: 'Bare', defaultParams: [{ id: 'effort', value: 'low' }] }, undefined, 'cursor'), [{ id: 'effort', value: 'low' }]);
  const cursor = reconcileModelParams(model, [{ id: 'reasoning_effort', value: 'nope' }], 'cursor');
  assert.equal(cursor?.find((item) => item.id === 'reasoning_effort')?.value, 'high');
  assert.equal(cursor?.find((item) => item.id === 'fast')?.value, 'YES');
  const codex = reconcileModelParams(model, [{ id: 'fast', value: 'off' }], 'codex');
  assert.equal(codex?.find((item) => item.id === 'fast')?.value, 'off');
  assert.equal(codex?.some((item) => item.id === 'reasoning_effort'), false);
  const invalidFallback = reconcileModelParams({ ...model, defaultParams: [{ id: 'reasoning_effort', value: 'missing' }] }, [{ id: 'reasoning_effort', value: 'nope' }], 'cursor');
  assert.equal(invalidFallback?.some((item) => item.id === 'reasoning_effort') ?? false, false);
  assert.deepEqual(filterModels([model], ''), [model]);
  assert.equal(filterModels([model], 'DESC').length, 1);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'codex', cwd: '/b' }), false);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'cursor', cwd: '/a' }), false);
  assert.equal(catalogIsCurrent({ requestId: 1, provider: 'codex', cwd: '/a' }, { requestId: 1, provider: 'codex', cwd: '/a' }), true);
  const tied = reconcileModelParams({
    id: 'm', label: 'M',
    parameters: [
      { id: 'zeta', label: 'Zeta', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
      { id: 'alpha', label: 'Alpha', values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
    ],
  }, [{ id: 'zeta', value: 'low' }, { id: 'alpha', value: 'high' }], 'codex');
  assert.deepEqual(tied?.map((item) => item.id), ['alpha', 'zeta']);
});

test('session titles and registry rows keep activity, fallbacks, and the focused conversation', async () => {
  assert.equal(sessionTitle(''), 'New chat');
  assert.equal(sessionTitle('x'.repeat(79)).length, 79);
  assert.equal(sessionTitle('x'.repeat(80)).length, 80);
  assert.equal(sessionTitle('x'.repeat(81)).length, 80);
  const current = [{ id: 'a', title: 'Saved', updatedAt: 't0', provider: 'codex' as const, cwd: '/work', activity: 'idle' as const, backend: 'sdk' as const }];
  const merged = mergeRegistrySessions(current, [
    { id: 'a', title: 'a', updatedAt: 't1', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'b', title: '', updatedAt: 't1', provider: 'codex', cwd: '/work' },
    { id: 'c', title: 'Real', updatedAt: 't1', provider: 'codex', cwd: '/work', activity: 'running' },
    { id: 'a', title: 'Renamed', updatedAt: 't2', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'a', title: '', updatedAt: 't3', provider: 'codex', cwd: '/work', backend: 'sdk' },
    { id: 'a', title: 'Other backend', updatedAt: 't1', provider: 'codex', cwd: '/work', backend: 'app-server' },
  ]);
  assert.equal(merged.find((item) => item.id === 'a' && item.backend === 'sdk')?.title, 'Renamed');
  assert.equal(merged.find((item) => item.id === 'a' && item.backend === 'sdk')?.activity, 'idle');
  assert.equal(merged.find((item) => item.id === 'b')?.title, 'b');
  assert.equal(merged.find((item) => item.id === 'c')?.activity, 'running');
  assert.equal(merged.filter((item) => item.id === 'a').length, 2);
  assert.equal(upsertSession([], { id: 'a', title: 'A', updatedAt: '', provider: 'cursor' })[0]?.title, 'A');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const front = new ChatController(selection(), async () => ({
    sessionId: 'front-session',
    async run() { entered(); await gate; },
    async dispose() {},
  }), () => {});
  const registry = new SessionRegistry(front, 'agent');
  const running = front.send('investigate registry titles that are longer than eighty characters and should be sliced at the boundary');
  await started;
  const waiting = new ChatController(selection(), async () => ({ sessionId: 'wait-session', async run() {}, async dispose() {} }), () => {});
  waiting.prepareResume('wait-session');
  await waiting.openSession();
  const pending = waiting.interactions.requestPermission({ id: 'p', title: 'Read', detail: 'file', kind: 'read' });
  await Promise.resolve();
  registry.add({ key: 'waiting', controller: waiting, mode: 'plan' });
  const errored = new ChatController(selection(), async () => ({ sessionId: 'err-session', async run() { throw new Error('boom'); }, async dispose() {} }), () => {});
  await errored.send('fail');
  registry.add({ key: 'errored', controller: errored, mode: 'ask' });
  const untitled = new ChatController(selection(), async () => ({ sessionId: 'only-id', async run() {}, async loadTranscript() {}, async dispose() {} }), () => {});
  untitled.prepareResume('only-id');
  await untitled.openSession();
  registry.add({ key: 'untitled', controller: untitled, mode: 'agent' });
  registry.focus('missing');
  assert.equal(registry.frontKey, 'front');
  assert.equal(registry.front, front);
  registry.focus('waiting');
  assert.equal(registry.frontKey, 'waiting');
  assert.equal(registry.mode(), 'plan');
  registry.setMode('ask');
  assert.equal(registry.mode(), 'ask');
  assert.equal(registry.findBySession('err-session')?.key, 'errored');
  assert.equal(registry.findBySession('absent'), undefined);
  assert.equal(registry.activityFor('wait-session'), 'waiting');
  assert.equal(registry.activityFor('err-session'), 'error');
  assert.equal(registry.activityFor('front-session'), 'running');
  assert.equal(registry.activityFor('nobody'), undefined);
  const rows = registry.liveSummaries();
  assert.equal(rows.find((item) => item.id === 'only-id')?.title, 'only-id');
  assert.equal(rows.find((item) => item.id === 'wait-session')?.title, 'wait-session');
  assert.equal(rows.find((item) => item.id === 'front-session')?.title.length, 80);
  const background = [...registry.background()].map((entry) => entry.key);
  assert.equal(background.includes('waiting'), false);
  assert.deepEqual(background.sort(), ['errored', 'front', 'untitled']);
  (registry as unknown as { items: Map<string, unknown> }).items.delete('waiting');
  assert.throws(() => registry.front, /会話が見つかりません/);
  assert.throws(() => registry.mode(), /会話が見つかりません/);
  assert.throws(() => registry.setMode('agent'), /会話が見つかりません/);
  waiting.resolvePermission('p', 'deny');
  await pending;
  release();
  await running;
  await front.dispose();
  await waiting.dispose();
  await errored.dispose();
  await untitled.dispose();
});

test('terminal mirror covers Japanese text, list races, redraws, and duplicate errors', async () => {
  const writes: string[] = [];
  let listed!: (rows: { processId: string; status?: string; output?: string; exitCode?: number; error?: string }[]) => void;
  const pending = new Promise<{ processId: string; status?: string; output?: string; exitCode?: number }[]>((resolve) => { listed = resolve; });
  let listener: ((update: import('../../src/types.js').AgentUpdate) => void) | undefined;
  const session = {
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => pending,
    subscribeBackgroundUpdates(next: (update: import('../../src/types.js').AgentUpdate) => void) { listener = next; return () => { listener = undefined; }; },
  };
  const monitor = new TerminalMonitor(session, { processId: 'p', itemId: 'item', command: 'job', output: 'old\r\n' }, (text) => writes.push(text), true);
  monitor.open();
  monitor.open();
  assert.equal(writes.filter((text) => text.includes('既存のバックグラウンド')).length, 1);
  listener?.({ id: 'item', role: 'tool', text: 'job', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  listener?.({ id: 'item', role: 'tool', text: 'replaced', tool: { name: 'shell', kind: 'shell', status: 'running' } });
  assert.equal(writes.some((text) => text.includes('\x1b[2J')), true);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  listed([{ processId: 'p', status: 'complete', output: 'late', exitCode: 0 }]);
  await pending;
  await flushMicrotasks();
  assert.equal(writes.some((text) => text.includes('プロセス終了')), false);
  listener?.({ id: 'terms', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', error: 'disk full', status: 'running' }] } });
  listener?.({ id: 'terms', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', error: 'disk full', status: 'running' }] } });
  assert.equal(writes.filter((text) => text.includes('disk full')).length, 1);
  listener?.({ id: 'terms-2', role: 'status', text: '', meta: { type: 'terminals', terminals: [{ processId: 'p', status: 'complete', exitCode: 3, output: 'replaced\r\n' }] } });
  assert.equal(writes.some((text) => text.includes('プロセス終了: 3')), true);
  monitor.handleInput('plain');
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(writes.filter((text) => text.includes('割り込みに対応していません')).length, 1);
  monitor.dispose();
  const before = writes.length;
  listener?.({ id: 'item', role: 'tool', text: 'after close', tool: { name: 'shell', kind: 'shell', status: 'completed' } });
  monitor.open();
  assert.equal(writes.length, before);
});

test('a background list error is not an exit, and a missing row finishes the mirror', async () => {
  let rejectList!: (error: unknown) => void;
  const failing = new Promise<never>((_resolve, reject) => { rejectList = reject; });
  const output: string[] = [];
  const monitor = new TerminalMonitor({
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => failing,
  }, { processId: 'p' }, (text) => output.push(text), false);
  monitor.open();
  rejectList(new Error('list failed'));
  await flushMicrotasks();
  assert.equal(output.some((text) => text.includes('list failed')), true);
  assert.equal(output.some((text) => text.includes('Process exited')), false);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(output.filter((text) => text.includes('does not support interrupting')).length, 1);
  monitor.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(output.filter((text) => text.includes('does not support interrupting')).length, 1);
  monitor.dispose();
  let resolveRows!: (rows: []) => void;
  const rows = new Promise<[]>((resolve) => { resolveRows = resolve; });
  const second: string[] = [];
  const finished = new TerminalMonitor({
    async run() {}, async dispose() {},
    listBackgroundTerminals: () => rows,
    async interruptBackgroundTerminal() { throw 'boom'; },
  }, { processId: 'gone', command: 'sleep' }, (text) => second.push(text), false);
  finished.open();
  finished.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(second.filter((text) => text.includes('boom')).length, 1);
  finished.handleInput('\x03');
  await flushMicrotasks();
  assert.equal(second.filter((text) => text.includes('boom')).length, 1);
  resolveRows([]);
  await rows;
  await flushMicrotasks();
  assert.equal(second.some((text) => text.includes('Process exited')), true);
  const listed: string[] = [];
  const completed = new TerminalMonitor({
    async run() {}, async dispose() {},
    async listBackgroundTerminals() { return [{ processId: 'p', status: 'complete', exitCode: 0, output: 'done\n' }]; },
  }, { processId: 'p', output: '' }, (text) => listed.push(text), false);
  completed.open();
  await flushMicrotasks();
  assert.equal(listed.some((text) => text.includes('Process exited: 0')), true);
  assert.equal(listed.some((text) => text.includes('done')), true);
});

test('prompt expansion respects workspace boundaries, caps, and missing files', async () => {
  const root = await tempDir('ai-agents-context-gap-');
  const outside = await tempDir('ai-agents-context-out-');
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'secret', { mode: 0o600 });
    await writeFile(path.join(root, 'readme.md'), 'hello context');
    await writeFile(path.join(root, 'note.txt'), 'quoted');
    await writeFile(path.join(root, 'big.bin'), Buffer.from([0x61, 0, 0x62]));
    await writeFile(path.join(root, 'exact.txt'), 'e'.repeat(40_000));
    await writeFile(path.join(root, 'over.txt'), 'o'.repeat(40_001));
    await writeFile(path.join(root, 'bytes.txt'), 'b'.repeat(160_000));
    await writeFile(path.join(root, 'too-big.txt'), 'z'.repeat(160_001));
    await mkdir(path.join(root, 'sub', 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'ok.ts'), 'export const ok = 1;\n');
    await writeFile(path.join(root, 'sub', 'node_modules', 'secret.ts'), 'export const hidden = 1;\n');
    await mkdir(path.join(root, 'sub', 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a', 'b', 'c', 'deep.ts'), 'export const deep = 1;\n');
    await mkdir(path.join(root, 'sub', 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a', 'b', 'c', 'd', 'too.ts'), 'export const too = 1;\n');
    const many = path.join(root, 'many');
    await mkdir(many);
    for (let index = 0; index < 21; index += 1) await writeFile(path.join(many, `f${String(index).padStart(2, '0')}.md`), `body ${index}`);
    const names = path.join(root, 'names');
    await mkdir(names);
    for (let index = 0; index < 51; index += 1) await writeFile(path.join(names, `n${String(index).padStart(2, '0')}.dat`), 'x');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'file.txt'), 'hidden');
    await chmod(path.join(root, 'locked'), 0o000);
    const expanded = await expandPrompt('See @readme.md and @"note.txt" plus @missing.ts @../secret.txt @escape.txt @locked/file.txt', root);
    assert.match(expanded, /hello context/);
    assert.match(expanded, /quoted/);
    assert.match(expanded, /missing\.ts[\s\S]*\(missing\)/);
    assert.match(expanded, /outside the workspace/);
    assert.doesNotMatch(expanded, /```\nsecret\n```/);
    assert.doesNotMatch(expanded, /hidden/);
    const folder = await expandPrompt('@sub', root);
    assert.match(folder, /ok\.ts/);
    assert.match(folder, /deep\.ts/);
    assert.doesNotMatch(folder, /hidden/);
    assert.doesNotMatch(folder, /too\.ts/);
    const capped = await expandPrompt('@many', root);
    assert.equal(capped.match(/body \d+/g)?.length, 20);
    const listed = await expandPrompt('@names', root);
    assert.equal(listed.split('\n').filter((line) => line.startsWith('n')).length, 50);
    assert.match(await expandPrompt('@big.bin', root), /```\n\n```/);
    assert.match(await expandPrompt('@exact.txt', root), new RegExp(`e{${40_000}}`));
    assert.doesNotMatch(await expandPrompt('@exact.txt', root), /truncated/);
    assert.match(await expandPrompt('@over.txt', root), /truncated/);
    assert.match(await expandPrompt('@bytes.txt', root), /truncated/);
    assert.match(await expandPrompt('@too-big.txt', root), /```\n\n```/);
    assert.equal(resolveInside(root, ''), undefined);
    assert.equal(resolveInside(root, 'a\0b'), undefined);
    assert.equal(resolveInside(root, '../secret.txt'), undefined);
    assert.equal(parseFrontmatter('no header').title, '');
    assert.equal(parseFrontmatter('---\nname: "Quoted"\n').body, '---\nname: "Quoted"\n');
    const front = parseFrontmatter('---\nname: "Quoted"\ndescription: \'Desc\'\n---\nBody');
    assert.equal(front.title, 'Quoted');
    assert.equal(front.description, 'Desc');
    assert.equal(front.body, 'Body');
    assert.equal(builtinCommand('hello'), undefined);
    assert.deepEqual(builtinCommand('/Diagnostics'), { name: 'diagnostics', rest: '' });
    const long = 'y'.repeat(20_001);
    const commands: SlashCommand[] = [{ name: 'Ship', title: 'Ship', description: '', kind: 'command', body: long }];
    const slash = await expandPrompt('/Ship now', root, commands);
    assert.equal(slash.includes('y'.repeat(20_001)), false);
    assert.match(slash, new RegExp(`y{${20_000}}`));
    const blocks = Array.from({ length: 10 }, (_item, index) => ({ name: `c${index}`, title: '', description: '', kind: 'skill' as const, body: 'x'.repeat(20_000) }));
    const huge = await expandPrompt(blocks.map((item) => `/${item.name}`).join('\n'), root, blocks);
    assert.equal(huge.length, 180_000 + '\n…(context truncated)'.length);
    assert.match(huge, /context truncated/);
    const small = await expandPrompt('/c0', root, [blocks[0]!]);
    assert.equal(small.includes('context truncated'), false);
    assert.deepEqual(suggestionToken('look @src/a', 11), { kind: 'file', query: 'src/a', start: 5 });
    assert.deepEqual(suggestionToken('hello\n/rev', 10), { kind: 'slash', query: 'rev', start: 6 });
    assert.equal(suggestionToken('plain', 5), undefined);
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
    assert.equal((await stat(path.join(outside, 'secret.txt'))).mode & 0o777, 0o600);
  } finally {
    await chmod(path.join(root, 'locked'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('diff helpers cover size boundaries, renames, empty deletions, and omitted hunks', () => {
  const fourThousand = `${'a\n'.repeat(4000)}`;
  const fourThousandOne = `${'a\n'.repeat(4001)}`;
  assert.deepEqual(lineChangeCounts(fourThousand, fourThousand), { additions: 0, deletions: 0 });
  assert.equal(lineChangeCounts(fourThousandOne, 'a\n'), undefined);
  assert.deepEqual(lineChangeCounts('', ''), { additions: 0, deletions: 0 });
  assert.deepEqual(previewTextDiff('same', 'same\n'), [
    { kind: 'context', line: 1, text: 'same' },
    { kind: 'eof', text: 'Newline at end of file' },
  ]);
  assert.deepEqual(previewTextDiff('same\n', 'same'), [
    { kind: 'context', line: 1, text: 'same' },
    { kind: 'eof', text: 'No newline at end of file' },
  ]);
  assert.deepEqual(previewTextDiff(null, ''), []);
  assert.deepEqual(previewTextDiff('', null), []);
  assert.deepEqual(previewTextDiff('old\r\n', 'new\r\n').map((row) => row.text), ['old', 'new']);
  assert.deepEqual(countUnifiedDiff('diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n'), { additions: 1, deletions: 1 });
  const crowded = previewTextDiff(['keep', ...'abcde'.split(''), 'tail'].join('\n'), ['keep', ...'ABCDE'.split(''), 'tail'].join('\n'), 2);
  assert.equal(crowded.filter((row) => row.kind === 'more').length, 2);
  assert.equal(crowded.at(-1)?.text, 'tail');
  assert.deepEqual(previewUnifiedDiff('no hunks'), []);
  assert.deepEqual(previewUnifiedDiff('@@ -1 +1 @@\n context\n'), []);
  const many = ['@@ -1,30 +1,30 @@', ' context', ...Array.from({ length: 20 }, (_item, index) => `-${index}`), ...Array.from({ length: 20 }, (_item, index) => `+${index}`), ' context'].join('\n');
  const preview = previewUnifiedDiff(many, 6);
  assert.equal(preview.some((row) => row.kind === 'more'), true);
  assert.equal(preview.length <= 6, true);
  const noEdgeContext = previewUnifiedDiff(['@@ -1,40 +1,40 @@', ...Array.from({ length: 20 }, (_item, index) => `-old${index}`), ...Array.from({ length: 20 }, (_item, index) => `+new${index}`)].join('\n'), 6);
  assert.equal(noEdgeContext.some((row) => row.kind === 'context'), false);
  assert.equal(noEdgeContext.some((row) => row.kind === 'more'), true);
  assert.equal(noEdgeContext.length <= 6, true);
  assert.equal(previewUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n').some((row) => row.kind === 'eof'), true);
  assert.equal(parseUnifiedDiff('   ').length, 0);
  const plain = parseUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(plain[0]?.path, 'x.ts');
  assert.equal(plain[0]?.kind, 'update');
  const removed = parseUnifiedDiff('diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n');
  assert.equal(removed[0]?.kind, 'delete');
  const added = parseUnifiedDiff('diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n');
  assert.equal(added[0]?.kind, 'add');
  const renamed = parseUnifiedDiff('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(renamed[0]?.kind, 'rename');
  assert.equal(renamed[0]?.oldPath, 'old.ts');
  assert.equal(parseUnifiedDiff('--- /dev/null\n+++ /dev/null\n').length, 0);
  assert.equal(normalizeChangeKind('move').kind, 'rename');
  assert.equal(normalizeChangeKind('bogus').kind, 'update');
  assert.equal(normalizeChangeKind(null).kind, 'update');
  assert.deepEqual(normalizeChangeKind({ type: 'update', movePath: 'from.ts' }), { kind: 'rename', movePath: 'from.ts' });
  assert.deepEqual(normalizeChangeKind({ type: 'move' }), { kind: 'rename' });
  assert.deepEqual(normalizeChangeKind({ type: 'other', move_path: 'from.ts' }), { kind: 'update', oldPath: 'from.ts' });
  assert.deepEqual(normalizeChangeKind({}), { kind: 'update' });
  assert.deepEqual(normalizeChangeKind({ type: 'other' }), { kind: 'update' });
  assert.equal(normalizeChangeKind({ type: 'delete' }).kind, 'delete');
  assert.equal(previousTextFromDiff('diff --git a/e.txt b/e.txt\ndeleted file mode 100644\n--- a/e.txt\n+++ /dev/null\n', 'delete'), '');
  assert.equal(previousTextFromDiff('@@ -1 +0,0 @@\n', 'delete'), undefined);
  assert.equal(previousTextFromDiff('@@ -1 +0,0 @@\n context\n', 'delete'), undefined);
  assert.equal(previousTextFromDiff('@@ -1 +1 @@\n-a\n', 'rename'), undefined);
  assert.equal(extensionBadge('dir/file.ts'), 'TS');
  assert.equal(extensionBadge('Makefile'), 'MAKE');
  assert.equal(extensionBadge('.gitignore'), '.GIT');
  assert.equal(extensionBadge('a.toolong'), 'TOOL');
  assert.equal(extensionBadge(''), 'FILE');
  assert.equal(extensionBadge('a.'), 'FILE');
});

test('workspace text and change stats reject escapes, symlinks, NUL, and size boundaries', async () => {
  const cwd = await tempDir('ai-agents-text-gap-');
  const outside = await tempDir('ai-agents-text-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  try {
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001), { mode: 0o640 });
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await symlink(secret, path.join(cwd, 'link.txt'));
    await mkdir(path.join(cwd, 'locked'));
    await writeFile(path.join(cwd, 'locked', 'hidden.txt'), 'hidden', { mode: 0o600 });
    await chmod(path.join(cwd, 'locked'), 0o000);
    assert.equal((await readWorkspaceText(cwd, 'exact.txt'))?.length, 500_000);
    assert.equal(await readWorkspaceText(cwd, 'over.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'nul.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'bad.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'link.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'missing.txt'), null);
    assert.equal(await readWorkspaceText(cwd, '../secret.txt'), undefined);
    assert.equal(await readWorkspaceText(cwd, 'locked/hidden.txt'), undefined);
    await chmod(path.join(cwd, 'locked'), 0o700);
    await writeFile(path.join(cwd, 'now.txt'), 'now\n', { mode: 0o640 });
    const huge = `${'a\n'.repeat(4001)}`;
    const refreshed = await refreshChangeStats(cwd, [
      { path: 'turn.diff', kind: 'update', diff: 'keep' },
      { path: 'patch', kind: 'update' },
      { path: 'now.txt', kind: 'update' },
      { path: 'now.txt', kind: 'update', previousText: 'old\n', previousMode: 0o644 },
      { path: 'missing.txt', kind: 'update', previousText: 'was\n' },
      { path: 'link.txt', kind: 'update', previousText: 'x' },
      { path: 'over.txt', kind: 'add', previousText: null },
      { path: 'wide.txt', kind: 'update', previousText: huge },
    ]);
    assert.equal(refreshed[0]?.diff, 'keep');
    assert.equal(refreshed[1]?.path, 'patch');
    assert.equal(refreshed[2]?.previousText, undefined);
    assert.equal(refreshed[3]?.kind, 'update');
    assert.equal(refreshed[3]?.additions, 1);
    assert.equal(refreshed[4]?.kind, 'delete');
    assert.equal(refreshed[5]?.previousText, 'x');
    assert.equal(refreshed[7]?.additions, undefined);
    const bare = { path: 'a', kind: 'update' as const };
    assert.equal(applyTextStats(bare, 'x'), bare);
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: null }, 'x').kind, 'add');
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: 'x' }, null).kind, 'delete');
    assert.equal(applyTextStats({ path: 'a', kind: 'update', previousText: 'x' }, undefined).kind, 'update');
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
    assert.equal((await stat(path.join(cwd, 'exact.txt'))).mode & 0o777, 0o640);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('baselines and revert refuse symlink escapes, oversized files, empty diffs, and failed applies', async () => {
  const cwd = await tempDir('ai-agents-review-gap-');
  const outside = await tempDir('ai-agents-review-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    const store = new Map<string, import('../../src/types.js').FileChange>();
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001));
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await symlink(secret, path.join(cwd, 'link.txt'));
    await captureBaseline(cwd, 'exact.txt', store);
    await captureBaseline(cwd, 'exact.txt', store);
    await writeFile(path.join(cwd, 'exact.txt'), 'changed');
    assert.equal(store.get(path.resolve(cwd, 'exact.txt'))?.previousText?.length, 500_000);
    await captureBaseline(cwd, 'over.txt', store);
    await captureBaseline(cwd, 'nul.txt', store);
    await captureBaseline(cwd, 'bad.txt', store);
    await captureBaseline(cwd, 'link.txt', store);
    await captureBaseline(cwd, 'missing.txt', store);
    await captureBaseline(cwd, '../secret.txt', store);
    assert.equal(store.has(path.resolve(cwd, '../secret.txt')), false);
    assert.equal(store.get(path.resolve(cwd, 'over.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'nul.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'bad.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'link.txt'))?.previousText, undefined);
    assert.equal(store.get(path.resolve(cwd, 'missing.txt'))?.kind, 'add');
    assert.equal(store.get(path.resolve(cwd, 'missing.txt'))?.previousText, null);
    await mkdir(path.join(cwd, 'locked'));
    await chmod(path.join(cwd, 'locked'), 0o000);
    await captureBaseline(cwd, 'locked/file.txt', store);
    assert.equal(store.get(path.resolve(cwd, 'locked/file.txt'))?.previousText, undefined);
    await chmod(path.join(cwd, 'locked'), 0o700);
    assert.equal(await captureGitBaselines(cwd), undefined);
    await writeFile(path.join(cwd, 'note.txt'), 'changed\n', { mode: 0o640 });
    await assert.rejects(revertChange({ path: path.join(cwd, 'link.txt'), kind: 'update', previousText: 'nope' }, [cwd]), /通常ファイル|ワークスペース外/);
    await assert.rejects(gitApplyReverse('  \n', cwd, [cwd]), /変更前の内容が無い/);
    await assert.rejects(gitApplyReverse('diff --git a/../secret.txt b/../secret.txt\n--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-secret\n+nope\n', cwd, [cwd]), /ワークスペース外/);
    await rm(path.join(cwd, 'link.txt'), { force: true });
    git('init', '-q');
    await writeFile(path.join(cwd, 'exec.sh'), 'echo ok\n', { mode: 0o755 });
    await writeFile(path.join(cwd, 'plain.txt'), 'head\n', { mode: 0o644 });
    await symlink('plain.txt', path.join(cwd, 'inside-link.txt'));
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
    const baselines = await captureGitBaselines(cwd);
    assert.ok(baselines);
    assert.equal(await baselines.lookupMode('exec.sh'), 0o755);
    assert.equal(await baselines.lookupMode('plain.txt'), 0o644);
    assert.equal(await baselines.lookupMode('inside-link.txt'), undefined);
    assert.notEqual(await baselines.lookup('inside-link.txt'), 'secret');
    assert.equal(await baselines.lookup('../secret.txt'), undefined);
    await rm(path.join(cwd, 'plain.txt'));
    await writeFile(path.join(cwd, 'added.txt'), 'new\n', { mode: 0o644 });
    const changes = await baselines.changes();
    assert.equal(changes.find((change) => change.path === 'plain.txt')?.kind, 'delete');
    assert.equal(changes.find((change) => change.path === 'added.txt')?.kind, 'add');
    assert.equal(changes.find((change) => change.path === 'added.txt')?.previousText, null);
    await writeFile(path.join(cwd, 'plain.txt'), 'changed\n');
    const applied = 'diff --git a/plain.txt b/plain.txt\n--- a/plain.txt\n+++ b/plain.txt\n@@ -1 +1 @@\n-head\n+changed\n';
    await revertChange({ path: 'plain.txt', kind: 'update', diff: applied }, [cwd]);
    assert.equal(await readFile(path.join(cwd, 'plain.txt'), 'utf8'), 'head\n');
    await writeFile(path.join(cwd, 'plain.txt'), 'other\n');
    await assert.rejects(gitApplyReverse(applied, cwd, [cwd]));
    assert.equal(await readFile(path.join(cwd, 'plain.txt'), 'utf8'), 'other\n');
    await assert.rejects(revertChange({ path: 'nope.txt', kind: 'update', diff: '' }, [cwd]), /変更前の内容が無い|ENOENT/);
    const merged = mergeFileChanges(
      [{ path: 'a.ts', kind: 'rename', oldPath: 'old.ts', previousText: 'first', previousMode: 0o644, diff: 'old', additions: 1 }],
      [{ path: 'a.ts', kind: '' as 'update', oldPath: 'other.ts', previousText: 'second', previousMode: 0o755, mode: 0o755, diff: '', preview: [], deletions: 2 }],
    );
    assert.equal(merged[0]?.kind, 'rename');
    assert.equal(merged[0]?.oldPath, 'old.ts');
    assert.equal(merged[0]?.previousText, 'first');
    assert.equal(merged[0]?.previousMode, 0o644);
    assert.equal(merged[0]?.diff, 'old');
    const moved = path.join(cwd, 'moved.txt');
    await writeFile(moved, 'now');
    await revertChange({ path: moved, oldPath: 'restored.txt', kind: 'rename', previousText: 'back\n', previousMode: 0o750 }, [cwd]);
    assert.equal(await readFile(path.join(cwd, 'restored.txt'), 'utf8'), 'back\n');
    assert.equal((await stat(path.join(cwd, 'restored.txt'))).mode & 0o777, 0o750);
    await assert.rejects(readFile(moved, 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
    assert.equal(isInsideWorkspace(cwd, [cwd]), true);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('rewind file reads and journals reject unsafe paths, modes, and failed rollbacks', async () => {
  const cwd = await tempDir('ai-agents-rewind-gap-');
  const outside = await tempDir('ai-agents-rewind-out-');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'secret', { mode: 0o640 });
  try {
    assert.deepEqual(await readSafeWorkspaceFile(cwd, 'missing.txt'), { text: null, mode: null });
    await writeFile(path.join(cwd, 'exact.txt'), 'a'.repeat(500_000), { mode: 0o640 });
    assert.equal((await readSafeWorkspaceFile(cwd, 'exact.txt')).text?.length, 500_000);
    assert.equal((await readSafeWorkspaceFile(cwd, 'exact.txt')).mode, 0o640);
    await writeFile(path.join(cwd, 'over.txt'), 'b'.repeat(500_001));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'over.txt'), /not a small regular file/);
    await writeFile(path.join(cwd, 'growing.txt'), 'initial contents');
    await assert.rejects(readSafeWorkspaceFile(cwd, 'growing.txt', async () => Buffer.alloc(500_001, 0x78)), /not a small regular file/);
    await writeFile(path.join(cwd, 'nul.txt'), Buffer.from([0x61, 0]));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'nul.txt'), /binary/);
    await writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'bad.txt'), /UTF-8/);
    await symlink(secret, path.join(cwd, 'link.txt'));
    await assert.rejects(readSafeWorkspaceFile(cwd, 'link.txt'), /not a small regular file/);
    await assert.rejects(readSafeWorkspaceFile(cwd, 'missing/a.txt'), /parent directory is missing/);
    await writeFile(path.join(cwd, 'not-dir.txt'), 'x');
    await assert.rejects(readSafeWorkspaceFile(cwd, 'not-dir.txt/child.txt'), /non-directory or symlink/);
    await mkdir(path.join(cwd, 'locked'));
    await chmod(path.join(cwd, 'locked'), 0o000);
    await assert.rejects(readSafeWorkspaceFile(cwd, 'locked/a.txt'), { code: 'EACCES' });
    await chmod(path.join(cwd, 'locked'), 0o700);
    assert.throws(() => workspaceRelativePath(cwd, '../secret.txt'), /not safely restorable/);
    const fileMode = 0o644;
    await writeFile(path.join(cwd, 'a.txt'), 'after', { mode: fileMode });
    const snapshot = { path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: fileMode, afterMode: fileMode };
    const saved = capturedTurn('t1', cwd, [snapshot]);
    await assert.rejects(buildTurnRewindPlan([saved], 'missing', cwd), /no longer in this conversation/);
    await assert.rejects(buildTurnRewindPlan([], 'missing', cwd), /no longer in this conversation/);
    await assert.rejects(buildTurnRewindPlan([{ ...saved, fileCheckpoint: { status: 'unsupported', files: [] } }], 't1', cwd), /complete file checkpoint is unavailable/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, path: '.' }])], 't1', cwd), /Unsafe checkpoint path/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, path: '/tmp/a.txt' }])], 't1', cwd), /Unsafe checkpoint path/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeText: 'a\0b' }])], 't1', cwd), /Unsupported file snapshot/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeMode: 0o1000 }])], 't1', cwd), /Unsupported file mode/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, beforeMode: -1 }])], 't1', cwd), /Unsupported file mode/);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [{ ...snapshot, afterMode: 1.5 }])], 't1', cwd), /Unsupported file mode/);
    const sameUser = capturedTurn('t1', cwd, [snapshot], { userMessageId: 't1' });
    const allowed = await buildTurnRewindPlan([sameUser], 't1', cwd);
    assert.equal(allowed.files.length, 1);
    const empty = await buildTurnRewindPlan([capturedTurn('t1', cwd, [])], 't1', cwd);
    assert.deepEqual(empty.files, []);
    const exact = 'x'.repeat(500_000);
    await writeFile(path.join(cwd, 'big.txt'), exact, { mode: fileMode });
    const bounded = await buildTurnRewindPlan([capturedTurn('t1', cwd, [
      { path: 'big.txt', beforeText: exact, afterText: exact, beforeMode: fileMode, afterMode: fileMode },
      { path: 'a.txt', beforeText: 'before', afterText: 'after', beforeMode: fileMode, afterMode: fileMode },
    ])], 't1', cwd);
    assert.equal(bounded.files.length, 2);
    await writeFile(path.join(cwd, 'big.txt'), `${exact}y`);
    await assert.rejects(buildTurnRewindPlan([capturedTurn('t1', cwd, [
      { path: 'big.txt', beforeText: exact, afterText: `${exact}y`, beforeMode: fileMode, afterMode: fileMode },
      { path: 'a.txt', beforeText: 'x', afterText: 'after', beforeMode: fileMode, afterMode: fileMode },
    ])], 't1', cwd), /safe size limit|Unsupported file snapshot/);
    await chmod(path.join(cwd, 'a.txt'), 0o755);
    await assert.rejects(buildTurnRewindPlan([saved], 't1', cwd), /changed after its checkpoint/);
    await chmod(path.join(cwd, 'a.txt'), fileMode);
    const journals = path.join(cwd, 'journals');
    const plan = await buildTurnRewindPlan([saved], 't1', cwd);
    const prepared = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, { ...plan, files: [] });
    assert.equal(prepared.journal.files.length, 0);
    await restoreTurnRewindFiles(prepared.journal);
    const readBack = await readTurnRewindJournal(prepared.path);
    assert.equal(readBack.version, 1);
    assert.equal(readBack.branchId, 'branch');
    await discardTurnRewindJournal(prepared.path);
    await discardTurnRewindJournal(prepared.path);
    const real = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, plan);
    real.journal.files[0]!.tempPath = path.join('nested', 'bad.tmp');
    await assert.rejects(restoreTurnRewindFiles(real.journal), /Invalid turn rewind journal/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    const modeLess = await prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, plan);
    modeLess.journal.files[0]!.beforeMode = null;
    await assert.rejects(restoreTurnRewindFiles(modeLess.journal), /no recorded mode/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    await writeFile(path.join(cwd, 'a.txt'), 'third', { mode: 0o640 });
    await writeFile(path.join(cwd, 'b.txt'), 'third-b', { mode: 0o640 });
    await assert.rejects(prepareTurnRewindJournal(journals, 'conversation', 'branch', cwd, {
      ...plan,
      files: [
        { path: 'a.txt', beforeText: 'before', beforeMode: fileMode, expectedText: 'after', expectedMode: fileMode },
        { path: 'b.txt', beforeText: 'before-b', beforeMode: fileMode, expectedText: 'after-b', expectedMode: fileMode },
      ],
    }), /changed before rewind began/);
    const crafted = {
      version: 1 as const, conversationId: 'conversation', branchId: 'branch', cwd,
      files: [
        { path: 'a.txt', beforeText: 'before', beforeMode: fileMode, expectedText: 'after', expectedMode: fileMode, backupText: 'after', backupMode: fileMode, tempPath: '.ai-agents-rewind-00000000-0000-4000-8000-000000000001.tmp' },
        { path: 'b.txt', beforeText: 'before-b', beforeMode: fileMode, expectedText: 'after-b', expectedMode: fileMode, backupText: 'after-b', backupMode: fileMode, tempPath: '.ai-agents-rewind-00000000-0000-4000-8000-000000000002.tmp' },
      ],
    };
    await assert.rejects(rollbackTurnRewindJournal(crafted), /a\.txt[\s\S]*b\.txt|b\.txt[\s\S]*a\.txt/);
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'third');
    assert.equal((await stat(path.join(cwd, 'a.txt'))).mode & 0o777, 0o644);
    await writeFile(path.join(cwd, 'a.txt'), 'before', { mode: fileMode });
    await rollbackTurnRewindJournal({ ...crafted, files: [crafted.files[0]!] });
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    const tempFile = path.join(cwd, crafted.files[0]!.tempPath);
    await writeFile(tempFile, 'interrupted temporary write');
    await rollbackTurnRewindJournal({ ...crafted, files: [crafted.files[0]!] });
    assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'after');
    await assert.rejects(readFile(tempFile), { code: 'ENOENT' });
    await writeFile(path.join(journals, 'bad.json'), '{');
    await assert.rejects(readTurnRewindJournal(path.join(journals, 'bad.json')), SyntaxError);
    const asDir = path.join(journals, 'directory.json');
    await mkdir(asDir);
    await assert.rejects(discardTurnRewindJournal(asDir), (error: NodeJS.ErrnoException) => error.code === 'EPERM' || error.code === 'EISDIR');
    assert.equal((await lstat(asDir)).isDirectory(), true);
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal((await stat(secret)).mode & 0o777, 0o640);
  } finally {
    await chmod(path.join(cwd, 'locked'), 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the shell shows every rewind phase, access banner, and optional plan or message field', () => {
  const controls = { ...defaultControls('codex', 'app-server'), sandbox: 'danger-full-access', approval: 'on-request', mode: 'plan' as const, webSearch: 'cached', network: true, additionalDirectories: ['/extra'] };
  const capabilities = capabilitiesFor('codex', 'app-server');
  const labels = {
    'rewind-check': ['巻き戻し可否を確認中…', 'Checking rewind safety…'],
    'rewind-branch': ['会話を分岐中…', 'Branching conversation…'],
    'rewind-files': ['ファイルを復元中…', 'Restoring files…'],
    'rewind-prepare': ['編集した依頼を準備中…', 'Preparing edited prompt…'],
    'rewind-send': ['編集した依頼を実行中…', 'Running edited prompt…'],
  } as const;
  for (const [label, [ja, en]] of Object.entries(labels)) {
    for (const locale of ['ja', 'en'] as const) {
      const source = shellSource({
        state: chatState('/workspace', []),
        controls, capabilities, locale,
        extra: { operationLabel: label as ChatState['operationLabel'], usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, busy: true, status: 'restoring' },
      });
      const shell = buildShell(source);
      assert.equal(shell.statusText.startsWith(locale === 'ja' ? ja : en), true);
      assert.match(shell.statusText, /in 2 \/ out 3/);
      assert.equal(shell.presence, 'running');
    }
  }
  const waiting = buildShell(shellSource({
    state: chatState('/workspace'), controls, capabilities, locale: 'ja',
    extra: { pendingPermission: { id: 'p', title: 't', detail: 'd', kind: 'shell' } },
    tokens: { permission: 'perm', plan: null, question: null },
  }));
  assert.equal(waiting.statusText.startsWith('承認待ち'), true);
  assert.equal(waiting.presence, 'waiting');
  assert.equal(waiting.permission?.token, 'perm');
  assert.equal(waiting.plan, null);
  const hiddenToken = buildShell(shellSource({
    state: chatState('/workspace'), controls, capabilities, locale: 'en',
    extra: { pendingPlan: { id: 'plan', plan: 'text', todos: [] }, pendingQuestion: { id: 'q', questions: [] } },
    tokens: { permission: null, plan: null, question: null },
  }));
  assert.equal(hiddenToken.plan, null);
  assert.equal(hiddenToken.question, null);
  assert.equal(hiddenToken.presence, 'waiting');
  const failed = buildShell(shellSource({
    state: chatState('/workspace'), controls, capabilities, locale: 'en', extra: { status: 'error' },
  }));
  assert.equal(failed.presence, 'error');
  assert.equal(failed.statusText.startsWith('Error'), true);
  const noFolder = buildShell(shellSource({ state: chatState('/missing'), controls, capabilities, locale: 'ja', folders: [] }));
  assert.equal(noFolder.folderName, 'フォルダなし');
  assert.equal(noFolder.statusText.startsWith('作業フォルダを開いてください'), true);
  assert.equal(noFolder.presence, 'idle');
  const stopping = buildShell(shellSource({ state: chatState('/workspace'), controls, capabilities, locale: 'en', extra: { status: 'cancelling', busy: true } }));
  assert.equal(stopping.statusText.startsWith('Stopping…'), true);
  const cursor = buildShell(shellSource({
    state: { ...chatState('/workspace'), selection: { provider: 'cursor', cwd: '/workspace', model: 'composer' }, autoApprove: true },
    controls: { ...defaultControls('cursor', 'acp'), sandbox: 'disabled' },
    capabilities: capabilitiesFor('cursor', 'acp'),
    locale: 'en',
  }));
  assert.equal(cursor.accessLabel, 'Off · Approve tools');
  assert.equal(cursor.banner?.title, 'Auto-approve is on');
  assert.equal(cursor.providers[0]?.label, 'Codex');
  assert.equal(cursor.providers[1]?.detail, 'SDK');
  const off = buildShell(shellSource({
    state: chatState('/workspace'),
    controls: { ...defaultControls('cursor', 'sdk'), sandbox: 'disabled' },
    capabilities: capabilitiesFor('cursor', 'sdk'),
    locale: 'ja',
  }));
  assert.equal(off.banner?.title, 'サンドボックスがオフです');
  const ready = readyPlan();
  ready.current = { ...ready.current!, restored: true };
  ready.revisions.push({ revision: 2, createdAt: 2, source: 'assistant-text', markdown: 'older' });
  const planned = buildShell(shellSource({
    state: {
      ...chatState('/workspace', [{ id: 'u', role: 'user', text: 'first line\nrest' }]),
      plan: { ...ready, error: 'kept' },
      sessions: [{ id: 'thread', title: 'Cursor', updatedAt: '', provider: 'codex', cwd: '/workspace' }, { id: 'other', title: 'Real', updatedAt: 't', provider: 'cursor', cwd: '/workspace' }],
      queue: [{ id: 'q1', text: 'hidden', extras: { displayText: 'shown', images: [{ mimeType: 'image/png', data: 'aa' }] } }, { id: 'q2', text: 'plain' }],
      subagents: [{ id: 'child', name: 'Child', status: 'completed', background: false, agentId: 'a', model: 'm', task: 'task', durationMs: 5, resultPreview: 'ok' }, { id: 'bare', name: 'Bare', status: 'running', background: true }],
      terminals: [{ processId: 'p', output: 'out', exitCode: 0, error: 'e', command: 'cmd', status: 'exited' }, { processId: 'bare' }],
      terminalError: 'terminal down',
      turns: [{ id: 't', startedAt: 1, endedAt: 2, waitMs: 3, status: 'completed', mode: 'agent', model: 'm', intent: 'chat', usage: { inputTokens: 1, outputTokens: 1 }, finalMessageId: 'final' }],
    },
    controls, capabilities, locale: 'en', sessionId: 'thread', conversationId: 'conv', showBuildModel: false,
    activeFile: { label: 'a.ts', token: '@a.ts' },
  }));
  assert.equal(planned.sessionTitle, 'first line');
  assert.equal(planned.planView?.showBuildModel, false);
  assert.equal(planned.planView?.restored, true);
  assert.equal(planned.planView?.files?.[0], 'a.ts');
  assert.equal(planned.planView?.history.length, 1);
  assert.equal(planned.queue[0]?.text, 'shown');
  assert.equal(planned.queue[0]?.images, 1);
  assert.equal(planned.queue[1]?.text, 'plain');
  assert.equal(planned.subagents[0]?.task, 'task');
  assert.equal(planned.subagents[1]?.task, undefined);
  assert.equal(planned.terminals[0]?.exitCode, 0);
  assert.equal(planned.terminals[1]?.command, undefined);
  assert.equal(planned.terminalError, 'terminal down');
  assert.equal(planned.timings[0]?.finalMessageId, 'final');
  assert.equal(planned.activeFile?.token, '@a.ts');
  assert.equal(planned.conversationId, 'conv');
  const generic = buildShell(shellSource({
    state: { ...chatState('/workspace', []), sessions: [{ id: 'thread', title: 'Codex', updatedAt: '', provider: 'codex' }] },
    controls, capabilities, locale: 'ja', sessionId: 'thread',
  }));
  assert.equal(generic.sessionTitle, '新しいチャット');
  const longPatch = presentChange({ path: 'turn.diff', kind: 'update', diff: 'x'.repeat(4001) }, ['/workspace']);
  assert.equal(longPatch.patch?.length, 4000);
  const additionsOnly = presentChange({ path: '/workspace/a.ts', kind: 'add', additions: 2 }, ['/workspace']);
  assert.equal(additionsOnly.additions, 2);
  assert.equal(additionsOnly.deletions, undefined);
  const outsideChange = presentChange({ path: '/etc/passwd', kind: 'update', diff: '+x\n', previousText: 'a' }, ['/workspace']);
  assert.equal(outsideChange.synthetic, true);
  assert.equal(outsideChange.canRevert, false);
  assert.deepEqual(countDiff('+++ b/a\n--- a/a\n+real\n'), { additions: 1, deletions: 0 });
  const message = toViewMessage({
    id: 'm', role: 'assistant', text: 'hi', turnId: 't', at: 1, final: true, attachments: ['a.ts'],
    failure: { kind: 'Error', retryable: false },
    tool: { kind: 'edit', name: 'edit', status: 'completed' },
    meta: { type: 'files', files: [{ path: 'a.ts', kind: 'update', additions: 1, deletions: 0, preview: [{ kind: 'add', text: 'a' }] }], todos: [{ content: 't', status: 'pending' }], task: 'task', imagePath: 'img.png', subagent: { id: 's', name: 'S', status: 'completed', background: false, task: 'do', durationMs: 1, resultPreview: 'ok' } },
  }, false);
  assert.equal(message.meta?.imagePath, 'img.png');
  assert.equal(message.meta?.subagent?.resultPreview, 'ok');
  assert.equal(message.failure?.retryable, false);
  const sparse = toViewMessage({ id: 's', role: 'tool', text: 'x', meta: { type: 'files', files: [{ path: 'a.ts', kind: 'update' }], subagent: { id: 's', name: 'S', status: 'running', background: true } } });
  assert.equal(sparse.meta?.files?.[0]?.additions, undefined);
  assert.equal(sparse.meta?.subagent?.task, undefined);
  assert.equal(sparse.turnId, undefined);
});

function shellSource(input: {
  state: ChatState;
  controls: AgentControls;
  capabilities: ReturnType<typeof capabilitiesFor>;
  locale: 'ja' | 'en';
  extra?: Partial<ChatState>;
  folders?: { name: string; path: string }[];
  tokens?: ShellSource['tokens'];
  sessionId?: string;
  conversationId?: string;
  showBuildModel?: boolean;
  activeFile?: ShellSource['activeFile'];
}): ShellSource {
  return {
    state: { ...input.state, ...input.extra },
    folders: input.folders ?? [{ name: 'workspace', path: '/workspace' }],
    modelLabel: 'gpt', hasModelDetails: true, capabilities: input.capabilities, controls: input.controls, locale: input.locale,
    tokens: input.tokens ?? { permission: null, plan: null, question: null },
    backends: { codex: 'app-server', cursor: 'sdk' },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.showBuildModel !== undefined ? { showBuildModel: input.showBuildModel } : {}),
    ...(input.activeFile !== undefined ? { activeFile: input.activeFile } : {}),
  };
}
