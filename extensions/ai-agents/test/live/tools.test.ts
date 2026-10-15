import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { revertChange } from '../../src/change-review.js';
import { createSession } from '../../src/providers/index.js';
import type { AgentUpdate, FileChange, PermissionDecision, PermissionRequest } from '../../src/types.js';
import type { SessionOptions } from '../../src/providers/session-options.js';

const enabled = process.env.AI_AGENTS_LIVE_TOOLS === '1';

function which(command: string): string {
  return execFileSync('which', ['-a', command], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0] ?? '';
}

async function workspace(): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-agents-tools-'));
  await writeFile(path.join(cwd, 'note.txt'), 'alpha\n');
  execFileSync('git', ['init'], { cwd });
  execFileSync('git', ['add', 'note.txt'], { cwd });
  execFileSync('git', ['-c', 'user.email=ai-agents@example.com', '-c', 'user.name=AI Agents', 'commit', '-m', 'init'], { cwd });
  return { cwd, async cleanup() { await rm(cwd, { recursive: true, force: true }); } };
}

function filesOf(updates: AgentUpdate[]): FileChange[] {
  return updates.flatMap((update) => update.meta?.type === 'files' ? update.meta.files ?? [] : []);
}

async function run(options: SessionOptions, prompt: string, decide: (request: PermissionRequest) => Promise<PermissionDecision>): Promise<AgentUpdate[]> {
  const updates: AgentUpdate[] = [];
  const session = await createSession({
    ...options,
    interactions: {
      requestPermission: decide,
      requestPlan: async () => 'rejected',
      requestAnswers: async () => ({}),
    },
  });
  try {
    await session.run(prompt, new AbortController().signal, (update) => updates.push(update));
  } finally { await session.dispose(); }
  return updates;
}

test('interactive backends deny a command and allow a file edit', { skip: !enabled, timeout: 300000 }, async () => {
  const agentPath = which('agent');
  assert.ok(agentPath);
  const cases: Array<{ name: string; options: Omit<SessionOptions, 'cwd' | 'storagePath' | 'interactions'> }> = [
    { name: 'cursor-acp', options: { provider: 'cursor', backend: 'acp', model: '', agentPath, sandbox: 'enabled' } },
    { name: 'codex-app-server', options: { provider: 'codex', backend: 'app-server', model: '', sandbox: 'workspace-write', approval: 'untrusted' } },
  ];
  for (const item of cases) {
    const { cwd, cleanup } = await workspace();
    try {
      let denied = false;
      for (let attempt = 0; attempt < 2 && !denied; attempt += 1) {
        await run({ ...item.options, cwd, storagePath: cwd },
          'Run this shell command and nothing else: printf no > denied.txt',
          async () => { denied = true; return 'deny'; });
      }
      assert.equal(denied, true, `${item.name} did not request approval`);
      await assert.rejects(access(path.join(cwd, 'denied.txt')));

      let allowed = false;
      let updates: AgentUpdate[] = [];
      for (let attempt = 0; attempt < 2 && !allowed; attempt += 1) {
        updates = await run({ ...item.options, cwd, storagePath: cwd },
          'Change note.txt so its entire contents are exactly beta followed by a newline. Do not edit any other file.',
          async () => { allowed = true; return 'allow-once'; });
        if (!allowed && await readFile(path.join(cwd, 'note.txt'), 'utf8') === 'beta\n') {
          assert.fail(`${item.name} changed note.txt without an approval request`);
        }
      }
      assert.equal(allowed, true, `${item.name} edited a file without an approval request`);
      assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'beta\n');
      const change = filesOf(updates).find((file) => file.path.endsWith('note.txt') && (file.previousText !== undefined || file.diff));
      if (change?.previousText !== undefined) {
        await revertChange({ ...change, path: path.join(cwd, 'note.txt') }, [cwd]);
        assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'alpha\n');
      }
      console.log(`PASS ${item.name} deny allow file${change ? ' revert' : ''}`);
    } finally { await cleanup(); }
  }
});

test('SDK backends write inside the workspace sandbox without an approval prompt', { skip: !enabled, timeout: 300000 }, async () => {
  const cases: Array<{ name: string; options: Omit<SessionOptions, 'cwd' | 'storagePath' | 'interactions'> }> = [
    { name: 'cursor-sdk', options: { provider: 'cursor', backend: 'sdk', model: 'auto', sandbox: 'enabled' } },
    { name: 'codex-sdk', options: { provider: 'codex', backend: 'sdk', model: '', sandbox: 'workspace-write', approval: 'never', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] } },
  ];
  for (const item of cases) {
    const { cwd, cleanup } = await workspace();
    let prompted = false;
    try {
      const updates = await run({ ...item.options, cwd, storagePath: cwd },
        'Read note.txt and change it so its entire contents are exactly beta followed by a newline. Do not edit any other file.',
        async () => { prompted = true; return 'deny'; });
      assert.equal(prompted, false, `${item.name} unexpectedly requested an interactive approval`);
      assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'beta\n');
      const change = filesOf(updates).find((file) => file.previousText !== undefined);
      if (change?.previousText !== undefined) {
        await revertChange(change, [cwd]);
        assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'alpha\n');
      }
      console.log(`PASS ${item.name} workspace edit${change ? ' revert' : ''}`);
    } finally { await cleanup(); }
  }
});
