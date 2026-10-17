import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { redactSecrets } from './types.js';

export interface DiagnosticCheck {
  label: string;
  ok: boolean;
  output: string;
}

export interface CursorDiagnosticEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  execPath: string;
  entry: string | undefined;
  homeDirectory: string;
  resolveSdkManifest(packageName: string): string;
  existsSync(file: string): boolean;
  statMode(file: string): number;
}

function systemCursorDiagnosticEnvironment(): CursorDiagnosticEnvironment {
  const require = createRequire(__filename);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    entry: process.argv[1],
    homeDirectory: os.homedir(),
    resolveSdkManifest: (packageName) => require.resolve(packageName),
    existsSync,
    statMode: (file) => statSync(file).mode,
  };
}

export function runProcess(command: string, args: string[], cwd?: string, timeoutMs = 8000): Promise<DiagnosticCheck> {
  const label = [command, ...args].join(' ');
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (ok: boolean, text: string) => {
      if (settled) return;
      settled = true;
      resolve({ label, ok, output: redactSecrets(text).slice(0, 4000) });
    };
    const executable = command.endsWith('.cjs') || command.endsWith('.js') || command.endsWith('.mjs') ? process.execPath : command;
    const spawnArgs = executable === process.execPath && executable !== command ? [command, ...args] : args;
    const child = spawn(executable, spawnArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      env: executable === process.execPath ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    });
    const timer = setTimeout(() => { child.kill(); finish(false, `${output}\nTimed out.`); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.stderr?.on('data', (chunk: string) => { output += chunk; });
    child.on('error', (error) => { clearTimeout(timer); finish(false, error.message); });
    child.on('exit', (code) => { clearTimeout(timer); finish(code === 0, output.trim() || `exit ${code ?? 'signal'}`); });
  });
}

export function cursorRuntimeDiagnostics(cwd: string, environment = systemCursorDiagnosticEnvironment()): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [{ label: 'Extension Host', ok: true, output: `${environment.platform}/${environment.arch} Node ${environment.nodeVersion}\n${environment.execPath}\nentry: ${environment.entry ?? '(none)'}` }];
  try {
    const packageName = `@cursor/sdk-${environment.platform}-${environment.arch}/package.json`;
    const manifest = environment.resolveSdkManifest(packageName);
    const binary = path.join(path.dirname(manifest), 'bin', environment.platform === 'win32' ? 'cursorsandbox.exe' : 'cursorsandbox');
    const ok = environment.existsSync(binary) && (environment.platform === 'win32' || Boolean(environment.statMode(binary) & 0o111));
    checks.push({ label: 'Cursor sandbox helper', ok, output: binary });
  } catch { checks.push({ label: 'Cursor sandbox helper', ok: false, output: `Missing @cursor/sdk-${environment.platform}-${environment.arch}. Reinstall the matching platform VSIX; sandbox remains enabled.` }); }
  for (const file of [path.join(environment.homeDirectory, '.cursor', 'sandbox.json'), path.join(cwd, '.cursor', 'sandbox.json')]) checks.push({ label: 'Sandbox policy', ok: true, output: `${file}: ${environment.existsSync(file) ? 'present (not modified)' : 'absent'}` });
  return checks;
}
