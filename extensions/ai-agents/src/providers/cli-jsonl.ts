import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { redactSecrets } from '../types.js';
import { stdioLaunch, type SpawnSpec } from './stdio-rpc.js';

export interface CliRunRequest extends SpawnSpec {
  input?: string;
}

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface CliRun {
  lines: AsyncIterable<string>;
  kill(): void;
  result(): Promise<CliExit>;
}

export type CliSpawn = (request: CliRunRequest) => CliRun;

export function spawnCli(request: CliRunRequest, launchProcess: typeof spawn = spawn): CliRun {
  const launch = stdioLaunch(request, process.platform, process.execPath);
  const child = launchProcess(launch.command, launch.args, {
    cwd: request.cwd,
    env: request.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: launch.shell,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  // CLI validation errors put the reason before the (potentially huge) model list.
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 4000); });
  child.stdin?.on('error', () => undefined);
  if (request.input !== undefined) child.stdin?.write(request.input);
  child.stdin?.end();
  const lines = child.stdout ? createInterface({ input: child.stdout }) : emptyLines();
  const result = new Promise<CliExit>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stderr: redactSecrets(stderr.trim() || error?.message || '') });
    };
    child.on('error', (error) => finish(null, null, error));
    // close follows the final stderr data; exit can arrive before the pipes drain.
    child.on('close', (code, signal) => finish(code, signal));
  });
  return {
    lines,
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* The process can exit between the check and kill. */ }
      }
    },
    result: () => result,
  };
}

export async function readCliText(run: CliRun, signal: AbortSignal): Promise<string> {
  let stdout = '';
  await readLines(run, signal, (line) => { stdout += `${line}\n`; });
  return stdout;
}

export async function readJsonEvents(run: CliRun, signal: AbortSignal, onEvent: (event: unknown) => void | Promise<void>): Promise<void> {
  await readLines(run, signal, async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: unknown;
    try { event = JSON.parse(trimmed) as unknown; }
    catch { return; }
    await onEvent(event);
  });
}

async function readLines(run: CliRun, signal: AbortSignal, onLine: (line: string) => void | Promise<void>): Promise<void> {
  const aborted = () => run.kill();
  if (signal.aborted) {
    run.kill();
    throw abortError(signal);
  }
  signal.addEventListener('abort', aborted, { once: true });
  try {
    for await (const line of run.lines) {
      if (signal.aborted) break;
      await onLine(line);
    }
    const finished = await run.result();
    if (signal.aborted) throw abortError(signal);
    if (finished.code !== 0 || finished.signal) {
      throw new Error(finished.stderr || `CLI process exited (${finished.code ?? finished.signal ?? 'signal'}).`);
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    run.kill();
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('Cancelled', 'AbortError');
}

async function* emptyLines(): AsyncGenerator<string> { /* A process without stdout has no events. */ }
