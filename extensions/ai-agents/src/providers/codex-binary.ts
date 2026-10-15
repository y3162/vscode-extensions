import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SpawnSpec } from './stdio-rpc.js';

export interface ResolvedLaunch extends SpawnSpec {
  kind: 'bundled' | 'override' | 'path';
  version?: string;
}

export function codexSpawn(codexPath: string | undefined, args: string[], cwd?: string, apiKey?: string): SpawnSpec {
  return codexLaunch(codexPath, args, cwd, apiKey);
}

export function codexLaunch(codexPath: string | undefined, args: string[], cwd?: string, apiKey?: string): ResolvedLaunch {
  const env = { ...process.env, ...(apiKey ? { CODEX_API_KEY: apiKey } : {}) };
  if (codexPath) return { kind: 'override', command: codexPath, args, cwd, env };
  const bundled = createRequire(__filename).resolve('@openai/codex/bin/codex.js');
  return {
    kind: 'bundled',
    version: bundledCodexVersion(bundled),
    command: process.execPath,
    args: [bundled, ...args],
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

function bundledCodexVersion(scriptPath: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(scriptPath), '..', 'package.json'), 'utf8')) as { version?: string };
    return manifest.version || 'unknown';
  } catch { return 'unknown'; }
}

export function agentLaunch(agentPath: string | undefined, args: string[], cwd?: string): ResolvedLaunch {
  const command = agentPath || 'agent';
  const kind = command.includes('/') || command.includes('\\') ? 'override' : 'path';
  return { kind, command, args, cwd };
}
