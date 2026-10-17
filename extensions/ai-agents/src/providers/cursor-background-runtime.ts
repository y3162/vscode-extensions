interface Shell { pid?: number }
interface BackgroundExecutor {
  getManager(): { runningShells: Map<number, Shell>; abort(id: number): boolean };
  dispose(): void;
}

const hookKey = Symbol.for('ai-agents.cursor-background-runtime.v1');
type HookGlobal = typeof globalThis & { [hookKey]?: CursorBackgroundRuntime };

/** Owns the SDK's native background executors for the lifetime of one worker session. */
export class CursorBackgroundRuntime {
  private readonly retained = new Set<BackgroundExecutor>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  release(executor: BackgroundExecutor): void {
    if (this.disposed || !executor.getManager().runningShells.size) {
      this.retained.delete(executor);
      executor.dispose();
      return;
    }
    this.retained.add(executor);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.disposed || !this.retained.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const executor of this.retained) {
        if (executor.getManager().runningShells.size) continue;
        this.retained.delete(executor);
        executor.dispose();
      }
      this.schedule();
    }, 100);
    this.timer.unref();
  }

  interrupt(shellId: number, pid: number): boolean {
    for (const executor of this.retained) {
      const manager = executor.getManager();
      if (manager.runningShells.get(shellId)?.pid === pid) return manager.abort(shellId);
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const executor of this.retained) executor.dispose();
    this.retained.clear();
  }
}

export function installCursorBackgroundRuntime(): CursorBackgroundRuntime {
  const host = globalThis as HookGlobal;
  if (host[hookKey]) throw new Error('Cursor background runtime is already installed in this worker.');
  return host[hookKey] = new CursorBackgroundRuntime();
}

export function cursorBackgroundRuntime(): CursorBackgroundRuntime | undefined {
  return (globalThis as HookGlobal)[hookKey];
}
