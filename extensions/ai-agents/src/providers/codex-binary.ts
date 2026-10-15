import { createRequire } from 'node:module';
import type { SpawnSpec } from './stdio-rpc.js';

export function codexSpawn(codexPath: string | undefined, args: string[], cwd?: string, apiKey?: string): SpawnSpec {
  const env = { ...process.env, ...(apiKey ? { CODEX_API_KEY: apiKey } : {}) };
  if (codexPath) return { command: codexPath, args, cwd, env };
  const bundled = createRequire(__filename).resolve('@openai/codex/bin/codex.js');
  return {
    command: process.execPath,
    args: [bundled, ...args],
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  };
}
