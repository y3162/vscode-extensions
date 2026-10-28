import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
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
  if (command === 'agent' && process.platform !== 'win32') {
    const executable = (file: string) => {
      try { accessSync(file, constants.X_OK); return true; } catch { return false; }
    };
    const found = (process.env.PATH ?? '').split(path.delimiter).some((dir) => executable(path.resolve(cwd ?? process.cwd(), dir || '.', command)));
    const installed = path.join(homedir(), '.local', 'bin', 'agent');
    if (!found && executable(installed)) return { kind: 'path', command: installed, args, cwd };
  }
  return { kind, command, args, cwd };
}
