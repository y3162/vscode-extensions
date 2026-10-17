import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CursorBackgroundRuntime, cursorBackgroundRuntime, installCursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';

test('turn cleanup preserves a live background shell and releases it after natural exit', async () => {
  const runtime = new CursorBackgroundRuntime();
  const shells = new Map([[42, { pid: 9000 }]]);
  let disposed = 0;
  const executor = { getManager: () => ({ runningShells: shells, abort: () => false }), dispose: () => { disposed++; } };
  runtime.release(executor);
  runtime.release(executor);
  assert.equal(disposed, 0, 'ending a turn must not kill the shell');
  shells.clear();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(disposed, 1, 'completed executors must not leak');
  runtime.dispose();
  assert.equal(disposed, 1);
});

test('interrupt is scoped to both SDK shell id and PID, and session disposal stops every retained shell', () => {
  const runtime = new CursorBackgroundRuntime();
  const shells = new Map([[42, { pid: 9000 }], [43, { pid: 9001 }]]);
  const aborted: number[] = [];
  let disposed = 0;
  runtime.release({ getManager: () => ({ runningShells: shells, abort: (id) => { aborted.push(id); return shells.delete(id); } }), dispose: () => { disposed++; shells.clear(); } });
  assert.equal(runtime.interrupt(42, 1234), false);
  assert.equal(runtime.interrupt(43, 9000), false);
  assert.deepEqual(aborted, []);
  assert.equal(runtime.interrupt(42, 9000), true);
  assert.deepEqual(aborted, [42]);
  assert.equal(shells.has(43), true);
  runtime.dispose();
  assert.equal(disposed, 1);
  assert.equal(shells.size, 0);
  runtime.release({ getManager: () => ({ runningShells: new Map([[44, { pid: 9002 }]]), abort: () => false }), dispose: () => { disposed++; } });
  assert.equal(disposed, 2, 'late cleanup after worker disposal cannot retain resources');
});

test('repeated SDK cleanup after natural exit or worker disposal disposes an executor only once', async () => {
  const runtime = new CursorBackgroundRuntime();
  let disposed = 0;
  const shells = new Map([[42, { pid: 9000 }]]);
  const executor = { getManager: () => ({ runningShells: shells, abort: () => false }), dispose: () => { disposed++; } };
  runtime.release(executor);
  shells.clear();
  await new Promise((resolve) => setTimeout(resolve, 180));
  runtime.release(executor);
  runtime.dispose();
  runtime.release(executor);
  assert.equal(disposed, 1);

  const late = { getManager: () => ({ runningShells: shells, abort: () => false }), dispose: () => { disposed++; } };
  runtime.release(late);
  runtime.release(late);
  runtime.dispose();
  assert.equal(disposed, 2);
});

test('install is once per worker and a second live executor does not schedule twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const key = Symbol.for('ai-agents.cursor-background-runtime.v1');
  delete (globalThis as Record<symbol, unknown>)[key];
  const runtime = new CursorBackgroundRuntime();
  runtime.dispose();
  assert.equal(runtime.interrupt(1, 2), false);
  try {
    assert.equal(cursorBackgroundRuntime(), undefined);
    const installed = installCursorBackgroundRuntime();
    assert.equal(cursorBackgroundRuntime(), installed);
    assert.throws(() => installCursorBackgroundRuntime(), /already installed/);
    let disposed = 0;
    const running = new Map([[1, { pid: 2 }]]);
    const idle = new Map<number, { pid: number }>([[2, { pid: 3 }]]);
    installed.release({ getManager: () => ({ runningShells: running, abort: () => false }), dispose: () => { disposed++; } });
    installed.release({ getManager: () => ({ runningShells: idle, abort: () => false }), dispose: () => { disposed++; } });
    assert.equal(installed.interrupt(99, 1), false);
    idle.clear();
    t.mock.timers.tick(100);
    assert.equal(disposed, 1);
    running.clear();
    t.mock.timers.tick(100);
    assert.equal(disposed, 2);
    installed.dispose();
  } finally {
    delete (globalThis as Record<symbol, unknown>)[key];
  }
});

test('SDK compatibility transform is pinned and changes only background cleanup', async () => {
  const script = pathToFileURL(path.resolve(__dirname, '../../../scripts/cursor-runtime-patch.mjs')).href;
  const { patchCursorRuntime } = await import(script) as { patchCursorRuntime(source: string, version: string): string };
  const source = await readFile(path.join(path.dirname(createRequire(__filename).resolve('@cursor/sdk')), '464.js'), 'utf8');
  const patched = patchCursorRuntime(source, '1.0.37');
  assert.equal(patched.replace('globalThis[Symbol.for("ai-agents.cursor-background-runtime.v1")].release(this.backgroundShellExecutor)', 'this.backgroundShellExecutor.dispose()'), source);
  assert.throws(() => patchCursorRuntime(source, '1.0.38'), /Unsupported/);
  assert.throws(() => patchCursorRuntime(source + '\n', '1.0.37'), /Unsupported/);
});
