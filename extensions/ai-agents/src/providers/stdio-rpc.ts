import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { errorMessage, redactSecrets } from '../types.js';

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StdioLaunch {
  command: string;
  args: string[];
  shell: boolean;
}

export function stdioLaunch(spec: SpawnSpec, platform: NodeJS.Platform, execPath: string): StdioLaunch {
  const command = /\.(?:cjs|mjs|js)$/.test(spec.command) ? execPath : spec.command;
  const args = command === execPath && command !== spec.command ? [spec.command, ...spec.args] : spec.args;
  return { command, args, shell: platform === 'win32' && command !== execPath };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class StdioJsonRpc {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stderr = '';
  private closed = false;
  private lastError = new Error('Agent process exited.');
  private onNotification: (method: string, params: unknown) => void = () => undefined;
  private onServerRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({});
  private onClose: (error: Error) => void = () => undefined;

  constructor(spec: SpawnSpec) {
    const launch = stdioLaunch(spec, process.platform, process.execPath);
    this.child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: launch.shell,
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin?.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(redactSecrets(this.stderr.trim()) || `Agent process exited (${code ?? signal ?? 'signal'}).`));
    });
    if (!this.child.stdout || !this.child.stdin) throw new Error('Agent process did not expose stdio.');
    createInterface({ input: this.child.stdout }).on('line', (line) => { this.handleLine(line); });
  }

  setHandlers(handlers: {
    notification?: (method: string, params: unknown) => void;
    request?: (method: string, params: unknown) => Promise<unknown>;
    closed?: (error: Error) => void;
  }): void {
    if (handlers.notification) this.onNotification = handlers.notification;
    if (handlers.request) this.onServerRequest = handlers.request;
    if (handlers.closed) this.onClose = handlers.closed;
  }

  get isClosed(): boolean { return this.closed; }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(this.lastError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const pending: Pending = {
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      };
      this.pending.set(id, pending);
      if (this.closed || !this.write({ id, method, params })) {
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(this.lastError);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: number, result: unknown): void {
    this.write({ id, result });
  }

  failRequest(id: number, message: string): void {
    this.write({ id, error: { code: -32000, message } });
  }

  private write(message: unknown): boolean {
    if (this.closed || !this.child.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line) as typeof message; }
    catch { this.fail(new Error('Agent returned invalid JSON.')); return; }
    if (message.id !== undefined && message.method) {
      void this.onServerRequest(message.method, message.params).then((result) => {
        this.respond(message.id!, result);
      }, (error: unknown) => {
        this.failRequest(message.id!, errorMessage(error));
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error(message.error.message || 'Agent request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const wrapped = error instanceof Error ? error : new Error(redactSecrets(String(error)));
    const waiters = [...this.pending.values()];
    this.pending.clear();
    this.closed = true;
    this.lastError = wrapped;
    for (const pending of waiters) pending.reject(wrapped);
    this.onClose(wrapped);
  }

  async dispose(): Promise<void> {
    this.fail(new Error('Agent process closed.'));
    this.child.stdin?.end();
    this.child.kill();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
