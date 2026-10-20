import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import type { AgentsSidebar } from '../../src/sidebar.js';
import type { Backend, Provider } from '../../src/types.js';
import { createGitFixture, snapshotGitFixture } from '../support/git-fixture.js';

function assertFinalAnswers(sidebar: AgentsSidebar, count: number): void {
  const state = sidebar.controller.snapshot();
  assert.equal(state.turns.length, count);
  for (const turn of state.turns) {
    assert.equal(turn.status, 'completed');
    const answer = state.messages.find((message) => message.id === turn.finalMessageId);
    assert.ok(answer?.role === 'assistant' && answer.final && answer.text.trim(), `Missing final assistant answer for ${turn.id}`);
  }
}

export async function runReliability(sidebar: AgentsSidebar, cwd: string): Promise<void> {
  createGitFixture(cwd);
  snapshotGitFixture(cwd);
  const config = vscode.workspace.getConfiguration('ai-agents');
  await config.update('codex.executablePath', '', vscode.ConfigurationTarget.Global);
  const evidencePath = process.env.AI_AGENTS_RELIABILITY_EVIDENCE!;
  const rows: { provider: Provider; backend: Backend; id: string; usage: unknown; messages: number; turns: number }[] = [];
  if (process.env.AI_AGENTS_RELIABILITY_STAGE === 'reload') {
    const prior = JSON.parse(await readFile(evidencePath, 'utf8')) as typeof rows;
    for (const row of prior) {
      await sidebar.newChat(); await sidebar.handleMessage({ type: 'select', provider: row.provider, cwd });
      await sidebar.handleMessage({ type: 'restoreSession', id: row.id });
      const state = sidebar.controller.snapshot();
      assert.equal(state.messages.filter((m) => m.role === 'user').length, 3, `${row.provider}/${row.backend}: restored users`);
      assert.equal(state.turns.length, 3); assert.deepEqual(state.usage, row.usage);
      assertFinalAnswers(sidebar, 3);
      assert.ok(state.messages.some((m) => m.role === 'assistant' && m.text.includes('reliability')));
      await sidebar.handleMessage({ type: 'send', provider: row.provider, cwd, prompt: 'Reply exactly RELOADED. Do not use tools.' });
      assert.equal(sidebar.controller.snapshot().status, 'idle');
      assertFinalAnswers(sidebar, 4);
      assert.match(sidebar.controller.snapshot().messages.filter((m) => m.role === 'assistant').at(-1)!.text, /RELOADED/i);
      console.log(`RELIABILITY_RELOAD_PASS ${row.provider}/${row.backend}`);
    }
  } else {
    for (const [provider, backend] of [['cursor', 'sdk'], ['cursor', 'acp'], ['codex', 'sdk'], ['codex', 'app-server']] as [Provider, Backend][]) {
      await sidebar.newChat();
      await sidebar.handleMessage({ type: 'select', provider, cwd });
      await sidebar.handleMessage({ type: 'configure', backend, mode: 'agent', sandbox: provider === 'cursor' ? 'enabled' : 'read-only', approval: 'never' });
      await sidebar.controller.updateSelection({ provider, cwd, model: provider === 'cursor' ? 'composer-2.5' : 'gpt-6-luna', ...(provider === 'codex' ? { modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] } : {}) });
      for (const prompt of ['Hi. Remember the word reliability. Reply briefly without tools.', 'What word did I ask you to remember? Reply with that word only. Do not use tools.', 'Reply with Markdown **reliability** and a fenced JavaScript code block containing console.log("日本語 😀");. Do not use tools.']) {
        await sidebar.handleMessage({ type: 'send', provider, cwd, prompt });
        assert.equal(sidebar.controller.snapshot().status, 'idle', `${provider}/${backend}: ${JSON.stringify(sidebar.controller.snapshot().messages.filter((m) => m.role === 'error'))}`);
        assertFinalAnswers(sidebar, sidebar.controller.snapshot().turns.length);
      }
      const owner = sidebar.controller;
      const before = owner.snapshot(); const id = owner.sessionId()!; assert.ok(id);
      assert.equal(before.messages.filter((m) => m.role === 'user').length, 3);
      assertFinalAnswers(sidebar, 3);
      assert.match(before.messages.filter((m) => m.role === 'assistant')[1]!.text, /reliability/i);
      if (backend !== 'acp') { assert.ok(before.usage?.totalTokens && before.usage.totalTokens > 0); assert.equal(before.usage.source, `${provider}-${backend}`); }
      else assert.equal(before.usage, null, 'ACP does not provide usage');
      await sidebar.handleMessage({ type: 'refreshSessions' });
      await sidebar.openPanel('history');
      assert.ok((sidebar as any).history.get(id), 'snapshot exists before New Chat');
      await sidebar.newChat();
      assert.ok((sidebar as any).history.get(id), 'snapshot exists after New Chat');
      await sidebar.handleMessage({ type: 'restoreSession', id });
      assert.deepEqual(sidebar.controller.snapshot().messages, before.messages);
      const copied = before.messages.filter((m) => m.role === 'assistant').at(-1)!.text;
      const previous = await vscode.env.clipboard.readText();
      try {
        for (const text of [copied, '日本語 😀\nUnicode λ\n```js\nline\n```', '', 'long'.repeat(30000)]) {
          await sidebar.handleMessage({ type: 'copy', requestId: 'host-check', text });
          assert.equal(await vscode.env.clipboard.readText(), text);
        }
      } finally { await vscode.env.clipboard.writeText(previous); }
      rows.push({ provider, backend, id, usage: before.usage, messages: before.messages.length, turns: before.turns.length });
      await sidebar.flushHistory();
      console.log(`RELIABILITY_HOST_PASS ${provider}/${backend} ${JSON.stringify(before.usage)}`);
    }
    await writeFile(evidencePath, JSON.stringify(rows, null, 2));
  }
  await sidebar.flushHistory(); await sidebar.openPanel('chat');
  console.log('RELIABILITY_UI_READY', cwd, process.versions.node);
  if (process.env.AI_AGENTS_RELIABILITY_HOLD === '1' && process.env.AI_AGENTS_RELIABILITY_STAGE !== 'reload') {
    const deadline = Date.now() + 1200000;
    while (Date.now() < deadline) {
      try { await readFile(`${evidencePath}.release`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  }
  await sidebar.dispose();
}
