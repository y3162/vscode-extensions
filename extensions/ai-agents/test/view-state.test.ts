import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesFor, defaultControls } from '../src/capabilities.js';
import { buildShell, countDiff, diffMessages, presentChange, toViewMessage } from '../src/view-state.js';
import { emptyPlanState, type ChatState } from '../src/types.js';

function state(extra: Partial<ChatState> = {}): ChatState {
  return {
    selection: { provider: 'codex', cwd: '/workspace', model: 'gpt', modelParams: [{ id: 'modelReasoningEffort', value: 'high' }] },
    busy: false, messages: [], queue: [], status: 'idle', usage: null, changes: [], todos: [], sessions: [],
    autoApprove: false, pendingPermission: null, pendingPlan: null, pendingQuestion: null,
    plan: emptyPlanState(), turns: [], subagents: [], terminals: [], ...extra,
  };
}

test('message diffs send only changed rows and file stats come from a diff', () => {
  const first = toViewMessage({ id: 'a', role: 'assistant', text: 'Hi' });
  const initial = diffMessages(new Map(), [first]);
  assert.deepEqual(initial.upserts.map((message) => message.id), ['a']);
  const next = diffMessages(initial.next, [first, toViewMessage({ id: 'b', role: 'assistant', text: 'There' })]);
  assert.deepEqual(next.upserts.map((message) => message.id), ['b']);
  assert.deepEqual(next.removed, []);
  const trimmed = diffMessages(next.next, [toViewMessage({ id: 'b', role: 'assistant', text: 'There' })]);
  assert.deepEqual(trimmed.removed, ['a']);
  assert.deepEqual(countDiff('--- a/x\n+++ b/x\n+added\n-gone\n'), { additions: 1, deletions: 1 });
  const synthetic = presentChange({ path: 'turn.diff', kind: 'update', diff: '+only\n' }, ['/workspace']);
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.canRevert, false);
  assert.equal(synthetic.patch, '+only\n');
});

test('the access banner follows the real sandbox and can be dismissed', () => {
  const controls = { ...defaultControls('codex', 'app-server'), sandbox: 'danger-full-access', approval: 'on-request' };
  const source = {
    state: state(), folders: [{ name: 'workspace', path: '/workspace' }], modelLabel: 'gpt', hasModelDetails: true,
    capabilities: capabilitiesFor('codex', 'app-server'), controls, locale: 'ja' as const,
    tokens: { permission: null, plan: null, question: null }, dismissedWarning: null,
    backends: { codex: 'app-server' as const, cursor: 'sdk' as const },
  };
  const shell = buildShell(source);
  assert.equal(shell.accessLabel, 'Full access · On request');
  assert.equal(shell.risky, true);
  assert.equal(shell.banner?.title, 'フルアクセスがオンです');
  assert.equal(shell.effortLabel, 'High');
  assert.equal(shell.modelSettings, 'next-send');
  assert.equal(shell.showMode, true);
  const hidden = buildShell({ ...source, dismissedWarning: shell.banner?.id });
  assert.equal(hidden.banner, null);
  assert.equal(hidden.risky, true);
  const sdk = buildShell({
    ...source,
    capabilities: capabilitiesFor('codex', 'sdk'),
    controls: defaultControls('codex', 'sdk'),
  });
  assert.equal(sdk.showMode, false);
  assert.equal(sdk.banner, null);
});
