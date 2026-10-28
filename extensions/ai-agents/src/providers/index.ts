import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSession, FileChange } from '../types.js';
import { createCodexCliSession } from './codex-cli.js';
import { createCursorCliSession } from './cursor-cli.js';
import { createCodexAppServerSession } from './codex-app-server.js';
import { createManagedSession } from './managed-session.js';
import { createCursorAcpSession } from './cursor-acp.js';
import type { CliSpawn } from './cli-jsonl.js';
import type { SessionOptions } from './session-options.js';
import { writeImageFiles } from '../images.js';

export type { SessionOptions } from './session-options.js';

export async function createSession(options: SessionOptions, dependencies: { cliSpawn?: CliSpawn; writeImages?: typeof writeImageFiles } = {}): Promise<AgentSession> {
  if (options.backend === 'sdk') throw new Error('SDK sessions are no longer supported.');
  if (options.provider === 'codex' && options.backend === 'app-server') return process.platform === 'darwin' && options.ownerKey ? createManagedSession(options) : createCodexAppServerSession(options);
  if (options.provider === 'cursor' && options.backend === 'acp') return createCursorAcpSession(options);
  if (options.provider === 'cursor') return createCursorCliSession(options, dependencies.cliSpawn);
  return createCodexCliSession(options, { spawn: dependencies.cliSpawn, writeImages: dependencies.writeImages });
}

export async function writeBaselineFile(storagePath: string, change: FileChange): Promise<string> {
  await mkdir(storagePath, { recursive: true });
  const name = `${Buffer.from(change.path).toString('base64url').slice(0, 80)}-${path.basename(change.path)}`;
  const file = path.join(storagePath, name);
  await writeFile(file, change.previousText ?? '', 'utf8');
  return file;
}
