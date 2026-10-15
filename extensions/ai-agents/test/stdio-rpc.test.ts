import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StdioJsonRpc } from '../src/providers/stdio-rpc.js';

test('requests fail immediately after the agent process exits', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(1), 40)'],
  });
  await assert.rejects(rpc.request('noop', {}), /exited/);
  const started = Date.now();
  await assert.rejects(rpc.request('again', {}), /exited/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(rpc.isClosed, true);
  await rpc.dispose();
});
