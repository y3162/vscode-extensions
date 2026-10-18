import assert from 'node:assert/strict';

import { mock, test } from 'node:test';

import { CursorBackgroundRuntime } from '../../../src/providers/cursor-background-runtime.js';

test('background executor remains exactly-once disposed during a reentrant worker cleanup', () => {
  const runtime = new CursorBackgroundRuntime();
  const shells = new Map([[7, { pid: 700 }]]);
  let disposeCalls = 0;
  const executor = {
    getManager: () => ({ runningShells: shells, abort: () => false }),
    dispose() { disposeCalls += 1; runtime.dispose(); },
  };

  runtime.release(executor);
  runtime.dispose();
  assert.equal(disposeCalls, 1, 'a dispose callback that re-enters runtime cleanup is still called once');
  assert.equal(runtime.interrupt(7, 700), false, 'disposing clears the retained executor');
});
