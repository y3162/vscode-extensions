import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cursorBackgroundRuntime } from './cursor-background-runtime.js';

export async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  // Only the isolated worker loads the compatibility runtime. Catalog/auth callers
  // keep using the published SDK; all native execution and sandboxing remain SDK-owned.
  if (!cursorBackgroundRuntime()) return createRequire(__filename)('@cursor/sdk') as typeof import('@cursor/sdk');
  const packaged = path.join(__dirname, 'cursor-sdk', 'index.js');
  const entry = existsSync(packaged) ? packaged : path.resolve(__dirname, '../../dist/cursor-sdk/index.js');
  return createRequire(__filename)(entry) as typeof import('@cursor/sdk');
}
