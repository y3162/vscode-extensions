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
    await session.run(prompt, AbortSignal.timeout(120000), (update) => updates.push(update));
  } finally { await session.dispose(); }
  return updates;
}

const cases: Array<{ name: string; options: Omit<SessionOptions, 'cwd' | 'storagePath' | 'interactions'> }> = [
  { name: 'cursor-acp', options: { provider: 'cursor', backend: 'acp', model: '', sandbox: 'enabled' } },
  { name: 'codex-app-server', options: { provider: 'codex', backend: 'app-server', model: 'gpt-6-luna', sandbox: 'workspace-write', approval: 'untrusted' } },
  { name: 'cursor-sdk', options: { provider: 'cursor', backend: 'sdk', model: 'auto', sandbox: 'enabled' } },
  { name: 'codex-sdk', options: { provider: 'codex', backend: 'sdk', model: 'gpt-6-luna', sandbox: 'workspace-write', approval: 'never', modelParams: [{ id: 'modelReasoningEffort', value: 'low' }] } },
];

for (const item of cases) {
  test(`${item.name}: approvals and file changes`, { skip: !enabled, timeout: 300000 }, async () => {
    const { cwd, cleanup } = await workspace();
    const options = { ...item.options, cwd, storagePath: cwd, ...(item.options.backend === 'acp' ? { agentPath: which('agent') } : {}) };
    try {
      const interactive = item.options.backend === 'acp' || item.options.backend === 'app-server';
      if (interactive) {
        let denied = false;
        await run(options, 'Run exactly this shell command and nothing else. Do not use an edit tool instead: printf no > denied.txt', async () => { denied = true; return 'deny'; });
        assert.equal(denied, true, `${item.name} did not request approval for the command`);
        await assert.rejects(access(path.join(cwd, 'denied.txt')));
        let allowed = false;
        await run(options, 'Run exactly this shell command and nothing else. Do not use an edit tool instead: printf yes > allowed.txt', async () => { allowed = true; return 'allow-once'; });
        assert.equal(allowed, true, `${item.name} did not request approval for the allowed command`);
        assert.equal(await readFile(path.join(cwd, 'allowed.txt'), 'utf8'), 'yes');
      }
      let prompts = 0;
      const updates = await run(options,
        'Read note.txt and change it so its entire contents are exactly beta followed by a newline. Do not edit any other file.',
        async () => { prompts++; return interactive ? 'allow-once' : 'deny'; });
      if (!interactive) assert.equal(prompts, 0, 'SDK backends must not require an interactive response');
      assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'beta\n');
      const change = filesOf(updates).find((file) => file.path.endsWith('note.txt'));
      assert.ok(change, `${item.name} did not report the edited file`);
      assert.ok(!filesOf(updates).some((file) => file.kind === 'update' && !file.path.endsWith('note.txt')), 'reads must not become file changes');
      if (change.previousText !== undefined) {
        await revertChange({ ...change, path: path.join(cwd, 'note.txt') }, [cwd]);
        assert.equal(await readFile(path.join(cwd, 'note.txt'), 'utf8'), 'alpha\n');
      }
      console.log(`PASS ${item.name} model=${item.options.model || 'runtime-default'} file approvalRequests=${prompts} restored=${change.previousText !== undefined}`);
    } finally { await cleanup(); }
  });
}
