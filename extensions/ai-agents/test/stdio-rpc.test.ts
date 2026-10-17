import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StdioJsonRpc } from '../src/providers/stdio-rpc.js';

test('a server error result rejects the pending request', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'boom' } }) + '\\n');
      });
    `],
  });
  try { await assert.rejects(rpc.request('ping', {}), /boom/); }
  finally { await rpc.dispose(); }
});

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

test('invalid JSON closes the agent connection', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', "process.stdout.write('{bad\\n'); setInterval(() => {}, 1000);"],
  });
  try {
    await assert.rejects(rpc.request('ping', {}), /invalid JSON/);
    assert.equal(rpc.isClosed, true);
  } finally { await rpc.dispose(); }
});

test('a JSON response split across writes still resolves', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        const payload = JSON.stringify({ id: message.id, result: { ok: true } });
        process.stdout.write(payload.slice(0, 8));
        setTimeout(() => process.stdout.write(payload.slice(8) + '\\n'), 20);
      });
    `],
  });
  try {
    assert.deepEqual(await rpc.request('ping', {}), { ok: true });
  } finally { await rpc.dispose(); }
});

test('notifications are delivered and a blank line is ignored', async () => {
  const notes: unknown[] = [];
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', `
      process.stdout.write(JSON.stringify({ method: 'notice', params: { n: 1 } }) + '\\n');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        process.stdout.write('\\n' + JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
      });
    `],
  });
  rpc.setHandlers({ notification: (method, params) => notes.push({ method, params }) });
  try {
    assert.deepEqual(await rpc.request('ping', {}), { ok: true });
    assert.deepEqual(notes, [{ method: 'notice', params: { n: 1 } }]);
  } finally { await rpc.dispose(); }
});

test('aborting a request rejects it and does not leave it pending', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
  });
  try {
    const signal = new AbortController();
    const pending = rpc.request('hang', {}, signal.signal);
    signal.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(rpc.isClosed, false);
  } finally { await rpc.dispose(); }
});

test('stderr secrets are redacted when the agent exits', async () => {
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', "process.stderr.write('api_key=sk-fixturekey\\n'); process.exit(1);"],
  });
  try {
    await assert.rejects(rpc.request('ping', {}), (error: Error) => {
      assert.match(error.message, /\[redacted\]/);
      assert.equal(error.message.includes('fixturekey'), false);
      return true;
    });
  } finally { await rpc.dispose(); }
});

test('a server request is answered on stdin before the client request resolves', async () => {
  let asked = false;
  const rpc = new StdioJsonRpc({
    command: process.execPath,
    args: ['-e', `
      const readline = require('node:readline');
      let clientId;
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.method === 'ping') {
          clientId = message.id;
          process.stdout.write(JSON.stringify({ id: 9, method: 'ask', params: { q: 1 } }) + '\\n');
        } else if (message.id === 9) {
          process.stdout.write(JSON.stringify({ id: clientId, result: { answered: message.result.ok === true } }) + '\\n');
        }
      });
    `],
  });
  rpc.setHandlers({ request: async (method) => { asked = method === 'ask'; return { ok: true }; } });
  try {
    assert.deepEqual(await rpc.request('ping', {}), { answered: true });
    assert.equal(asked, true);
  } finally { await rpc.dispose(); }
});

