import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test, type TestContext } from 'node:test';
import { listModels } from '../../../src/providers/models.js';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeCodex(respond: (request: Record<string, unknown>, child: FakeChild) => void): FakeChild {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      if (signal === 'SIGKILL') this.signalCode = 'SIGKILL';
      else this.exitCode = 0;
      emitter.emit('exit', this.exitCode, this.signalCode);
      return true;
    },
  }) as FakeChild;

  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) respond(JSON.parse(line) as Record<string, unknown>, child);
    }
  });
  return child;
}

function writeMessage(child: FakeChild, message: unknown): void {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

function mockSpawn(t: TestContext, child: FakeChild): void {
  t.mock.method(childProcess, 'spawn', () => child as never);
}

test('Codex model RPC ignores notifications and unrelated IDs while accepting an empty initialize result', async (t) => {
  const child = fakeCodex((request, worker) => {
    if (request.method === 'initialize') {
      writeMessage(worker, { method: 'server/ready', params: {} });
      writeMessage(worker, { id: 999, result: { ignored: true } });
      writeMessage(worker, { id: request.id });
    }
    if (request.method === 'model/list') writeMessage(worker, { id: request.id, result: { data: [] } });
  });
  mockSpawn(t, child);

  assert.deepEqual(await listModels({ provider: 'codex', codexPath: '/fixture/codex' }), []);
  assert.equal(child.exitCode, 0);
});

test('Codex model RPC retains a transport failure between protocol requests and does not send a catalog request', async (t) => {
  const methods: string[] = [];
  const child = fakeCodex((request, worker) => {
    methods.push(String(request.method));
    if (request.method === 'initialize') {
      writeMessage(worker, { id: request.id, result: {} });
      worker.emit('error', new Error('transport dropped after initialize'));
    }
  });
  mockSpawn(t, child);

  await assert.rejects(
    listModels({ provider: 'codex', codexPath: '/fixture/codex' }),
    /transport dropped after initialize/,
  );
  assert.deepEqual(methods, ['initialize', 'initialized']);
  assert.equal(child.exitCode, 0);
});

test('Codex model RPC does not start the next request after cancellation during initialize', async (t) => {
  const controller = new AbortController();
  const methods: string[] = [];
  const child = fakeCodex((request, worker) => {
    methods.push(String(request.method));
    if (request.method === 'initialize') {
      writeMessage(worker, { id: request.id, result: {} });
      controller.abort();
    }
  });
  mockSpawn(t, child);

  await assert.rejects(
    listModels({ provider: 'codex', codexPath: '/fixture/codex', signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.deepEqual(methods, ['initialize', 'initialized']);
  assert.equal(child.exitCode, 0);
});
