import assert from 'node:assert/strict';

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import { test } from 'node:test';

import { AgentsSidebar } from '../../src/sidebar.js';

import type { AgentSession, AgentUpdate, SessionSummary } from '../../src/types.js';

import { env, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

import { createView, openSidebar, prepareHarnessRoot, type Harness } from '../support/vscode-harness.js';

function withSession(factory?: () => Promise<AgentSession>): Harness {
  const paths = prepareHarnessRoot();
  const output = window.createOutputChannel('AI Agents');
  const sessionFactory = factory ?? (async () => ({
    sessionId: 'round12-late-session',
    async run(prompt: string, _signal: AbortSignal, emit: (update: AgentUpdate) => void) {
      emit({ id: `round12-answer-${prompt.length}`, role: 'assistant', text: 'synthetic answer', final: true });
    },
    async dispose() {},
  }));
  const sidebar = new AgentsSidebar(paths.context as never, output as never, sessionFactory as never);
  return { ...paths, sidebar, output };
}

async function close(harness: Harness): Promise<void> {
  await harness.sidebar.dispose().catch(() => undefined);
  rmSync(harness.root, { recursive: true, force: true });
}

test('a Git-context send is refused if provider changes while its asynchronous context is being gathered', async () => {
  resetVscode();
  let factoryCalls = 0;
  const harness = withSession(async () => {
    factoryCalls += 1;
    return { sessionId: 'round12-stale-context-session', async run() {}, async dispose() {} };
  });
  const bin = path.join(harness.root, 'synthetic-bin');
  mkdirSync(bin, { recursive: true });
  const marker = path.join(harness.root, 'git-started.log');
  const fakeGit = path.join(bin, 'git');
  writeFileSync(fakeGit, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, 'started\\n');\nprocess.stdout.write('synthetic Git context');\nsetTimeout(() => process.exit(0), 350);\n`);
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
    const sending = harness.sidebar.handleMessage({ type: 'send', provider: 'codex', cwd: harness.workspacePath, prompt: '/diff inspect' });
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(marker), 'the synthetic Git subprocess started before the selection changed');

    await harness.sidebar.controller.select({ provider: 'cursor', cwd: harness.workspacePath, model: '' });
    await assert.rejects(sending, /送信準備中に会話の設定が変更されました/);
    assert.equal(harness.sidebar.controller.snapshot().selection.provider, 'cursor');
    assert.equal(harness.sidebar.controller.snapshot().messages.some((message) => message.role === 'user'), false,
      'stale context is discarded before creating a user turn');
    assert.equal(factoryCalls, 0, 'the invalidated prompt never creates or invokes a backend session');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await close(harness);
  }
});
