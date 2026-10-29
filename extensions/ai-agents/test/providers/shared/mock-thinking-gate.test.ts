import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

test('mock thinking gate emits its completion events and exits after release', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'thinking-gate-'));
  const child = spawn(process.execPath, [path.resolve('test/fixtures/mock-codex.cjs'), '-C', cwd], { stdio: ['pipe', 'pipe', 'pipe'] });
  const timeout = setTimeout(() => child.kill(), 10000);
  const events: Array<{ type: string; item?: { id: string; text: string } }> = [];
  try {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end('GUI_THINKING_GATE');
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line) as (typeof events)[number];
      events.push(event);
      if (event.type === 'item.updated') await writeFile(path.join(cwd, 'gui-complete-thinking'), '');
      if (event.type === 'item.completed' && event.item?.id === 'fixture_thinking') await writeFile(path.join(cwd, 'gui-start-tool'), '');
      if (event.type === 'item.started' && event.item?.id === 'fixture_tool') await writeFile(path.join(cwd, 'gui-release-thinking'), '');
    }
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.deepEqual(events.filter(event => event.item?.id === 'fixture_thinking').map(event => event.type), ['item.started', 'item.updated', 'item.completed']);
    assert.equal(events.find(event => event.type === 'item.completed' && event.item?.id === 'fixture_thinking')?.item?.text, '');
    assert.ok(events.some(event => event.type === 'turn.completed'));
    assert.ok(events.findIndex(event => event.type === 'item.started' && event.item?.id === 'fixture_tool') > events.findIndex(event => event.type === 'item.completed' && event.item?.id === 'fixture_thinking'));
    const trace = await readFile(path.join(cwd, 'gui-thinking-trace.jsonl'), 'utf8');
    assert.match(trace, /gate-released/);
    assert.match(trace, /process-exit:0/);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});
