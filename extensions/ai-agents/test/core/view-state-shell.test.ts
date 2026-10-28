import assert from 'node:assert/strict';

import path from 'node:path';

import { test } from 'node:test';

import { capabilitiesFor, defaultControls, normalizeControls, type AgentControls } from '../../src/capabilities.js';

import { mergeRegistrySessions, sessionTitle, upsertSession } from '../../src/session-index.js';

import { emptyPlanState, errorMessage, redactSecrets, type AgentModel, type ChatState, type PlanState, type Selection, type TurnFileSnapshot, type TurnRecord } from '../../src/types.js';

import { buildShell, countDiff, presentChange, toViewMessage, type ShellSource } from '../../src/view-state.js';

const mode = 0o644;

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

function readyPlan(phase: PlanState['phase'] = 'ready'): PlanState {
  return { phase, revisions: [{ revision: 1, createdAt: 1, source: 'assistant-text', markdown: 'Do the work', name: 'Name' }], current: planDocument(), build: { selection: selection(), label: 'Fixture' } };
}

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

function planDocument(extra: Partial<PlanState['current']> = {}) {
  return {
    id: 'plan-1', revision: 1, markdown: 'Do the work', todos: [{ content: 'step', status: 'pending' }],
    source: 'assistant-text' as const, createdAt: 1, name: 'Name', overview: 'Overview', files: ['a.ts'], ...extra,
  };
}

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
    controls: { ...defaultControls('cursor', 'cli'), sandbox: 'disabled' },
    capabilities: capabilitiesFor('cursor', 'cli'),
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
});;
