import { spawn } from 'node:child_process';
import { redactSecrets } from './types.js';

export interface DiagnosticCheck {
  label: string;
  ok: boolean;
  output: string;
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
