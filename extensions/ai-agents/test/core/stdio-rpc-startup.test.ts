
import assert from 'node:assert/strict';

import childProcess, { type ChildProcess } from 'node:child_process';

import { EventEmitter } from 'node:events';

import { PassThrough } from 'node:stream';

import { mock, test } from 'node:test';

import { StdioJsonRpc } from '../../src/providers/stdio-rpc.js';

import { commands, ExtensionContext, resetVscode, Uri, window, workspace } from '../support/vscode-stub.js';

async function command(name: string): Promise<unknown> {
  const handler = commands.handlers.get(name);
  assert.equal(typeof handler, 'function', `missing registered command ${name}`);
  return await handler!();
}

test('stdio RPC rejects children that do not expose both pipes', () => {
  for (const missing of ['stdout', 'stdin'] as const) {
    const child = Object.assign(new EventEmitter(), {
      stdin: missing === 'stdin' ? undefined : new PassThrough(),
      stdout: missing === 'stdout' ? undefined : new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawn = mock.method(childProcess, 'spawn', () => child as unknown as ChildProcess);
    try {
      assert.throws(() => new StdioJsonRpc({ command: 'agent', args: [] }), /did not expose stdio/);
    } finally {
      spawn.mock.restore();
    }
  }
});;
