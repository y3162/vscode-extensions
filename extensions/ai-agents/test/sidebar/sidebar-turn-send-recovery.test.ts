import assert from 'node:assert/strict';

import { rmSync, writeFileSync } from 'node:fs';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentModel, AgentSession, AgentUpdate, Selection } from '../../src/types.js';

import type { SessionOptions } from '../../src/providers/session-options.js';

import { commands, resetVscode, Uri, window } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, waitFor, type Harness } from '../support/vscode-harness.js';

function withFactory(factory: (options: SessionOptions) => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never, undefined, factory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a failed turn is logged once and the owning live session can complete the next send', async () => {
  resetVscode();
  let factoryCalls = 0;
  let runCalls = 0;
  const optionsSeen: SessionOptions[] = [];
  const harness = withFactory(async (options) => {
    factoryCalls += 1;
    optionsSeen.push(options);
    return {
      sessionId: 'round11-reused-session',
      async run(_prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
        runCalls += 1;
        if (runCalls === 1) throw new Error('synthetic turn failure');
        emit({ id: 'round11-recovered', role: 'assistant', text: 'recovered response', final: true });
      },
      async dispose() {},
    };
  });
  try {
    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'first request fails' });
    const failed = harness.sidebar.controller.snapshot();
    assert.equal(failed.status, 'error');
    assert.equal(failed.busy, false);
    assert.equal(failed.messages.some((message) => message.role === 'user' && message.text === 'first request fails'), true);
    assert.equal(failed.messages.some((message) => message.role === 'error' && message.text.includes('synthetic turn failure')), true);
    assert.equal(harness.output.lines.filter((line) => line.includes('synthetic turn failure')).length, 1);

    await harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: 'recover on the same session' });
    const recovered = harness.sidebar.controller.snapshot();
    assert.equal(factoryCalls, 1, 'the current conversation reuses its assigned backend session after the failed turn');
    assert.equal(runCalls, 2);
    assert.equal(optionsSeen[0]?.provider, 'codex');
    assert.equal(optionsSeen[0]?.cwd, harness.workspacePath);
    assert.equal(harness.sidebar.controller.sessionId(), 'round11-reused-session');
    assert.equal(recovered.status, 'idle');
    assert.equal(recovered.busy, false);
    assert.equal(recovered.messages.some((message) => message.role === 'assistant' && message.text === 'recovered response'), true);
    assert.equal(harness.output.lines.filter((line) => line.includes('synthetic turn failure')).length, 1, 'the same error message is not logged again on later state updates');
  } finally {
    await close(harness);
  }
});
