import type { AgentSession, AgentUpdate, TerminalRecord } from './types.js';

/** Mirrors one existing process. Opening/closing the view never launches or kills it. */
export class TerminalMonitor {
  private output = '';
  private unsubscribe?: () => void;
  private opened = false;
  private closed = false;
  private ended = false;
  private revision = 0;
  private lastError = '';
  private input = Promise.resolve();

  constructor(
    private readonly session: AgentSession,
    private readonly terminal: TerminalRecord,
    private readonly write: (text: string) => void,
    private readonly ja: boolean,
  ) {}

  open(): void {
    if (this.opened || this.closed) return;
    this.opened = true;
    this.write(`${this.terminal.command || this.terminal.processId}\r\n`);
    this.write(this.ja ? '既存のバックグラウンドプロセスに接続しました。\r\nCtrl+C: 実行を停止。文字入力の転送はこのランタイムでは未対応です。\r\n\r\n'
      : 'Connected to the existing background process.\r\nCtrl+C: stop execution. This runtime does not support forwarding text input.\r\n\r\n');
    this.unsubscribe = this.session.subscribeBackgroundUpdates?.((update) => this.update(update));
    this.append(this.terminal.output ?? '');
    const revision = this.revision;
    // Fetch after subscribing so output/exit between clicking and opening is not lost.
    void this.session.listBackgroundTerminals?.().then((rows) => {
      if (this.closed || this.ended || this.revision !== revision) return;
      const row = rows.find((item) => item.processId === this.terminal.processId);
      if (row) { this.append(row.output ?? this.output); if (row.status && /complete|cancel|fail|abort|exit/.test(row.status)) this.finish(row.exitCode); }
      else this.finish();
    }).catch((error: unknown) => this.error(error));
  }

  private update(update: AgentUpdate): void {
    if (this.closed) return;
    if (update.tool?.kind === 'shell' && update.id === this.terminal.itemId) {
      this.revision++;
      const command = this.terminal.command ?? '';
      const text = command && update.text.startsWith(`${command}\n`) ? update.text.slice(command.length + 1)
        : update.text === command ? '' : update.text;
      this.append(text);
      if (update.tool.status !== 'running') this.finish(update.tool.exitCode);
    }
    if (update.meta?.type === 'terminals' && update.meta.terminals) {
      this.revision++;
      const row = update.meta.terminals.find((item) => item.processId === this.terminal.processId);
      if (row) {
        this.append(row.output ?? this.output);
        if (row.error) this.error(row.error);
        if (row.status && /complete|cancel|fail|abort|exit/.test(row.status)) this.finish(row.exitCode);
      } else if (!update.meta.terminalError) this.finish();
      else this.error(update.meta.terminalError);
    }
  }

  private append(text: string): void {
    if (text === this.output || this.closed) return;
    // Runtime events contain cumulative snapshots, not deltas.
    if (text.startsWith(this.output)) this.write(text.slice(this.output.length).replace(/(?<!\r)\n/g, '\r\n'));
    else this.write(`\x1b[2J\x1b[H${text.replace(/(?<!\r)\n/g, '\r\n')}`);
    this.output = text;
  }

  private finish(exitCode?: number): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.write(`\r\n[${this.ja ? 'プロセス終了' : 'Process exited'}${exitCode !== undefined ? `: ${exitCode}` : ''}]\r\n`);
  }

  handleInput(data: string): void {
    if (this.closed || this.ended || !data.includes('\x03')) return;
    this.input = this.input.then(async () => {
      if (this.closed || this.ended) return;
      if (!this.session.interruptBackgroundTerminal) throw new Error(this.ja ? 'このランタイムは割り込みに対応していません。' : 'This runtime does not support interrupting a process.');
      await this.session.interruptBackgroundTerminal(this.terminal.processId);
      this.write('^C\r\n');
    }).catch((error: unknown) => this.error(error));
  }

  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.closed || this.lastError === message) return;
    this.lastError = message;
    this.write(`\r\n[${message}]\r\n`);
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
