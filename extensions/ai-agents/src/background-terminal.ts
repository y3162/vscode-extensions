import * as vscode from 'vscode';
import type { AgentSession, TerminalRecord } from './types.js';
import { TerminalMonitor } from './terminal-monitor.js';

export class BackgroundTerminalViews implements vscode.Disposable {
  private readonly views = new Map<AgentSession, Map<string, vscode.Terminal>>();

  open(session: AgentSession, row: TerminalRecord, ja: boolean): vscode.Terminal {
    let sessions = this.views.get(session);
    if (!sessions) { sessions = new Map(); this.views.set(session, sessions); }
    const existing = sessions.get(row.processId);
    if (existing) { existing.show(); return existing; }
    const output = new vscode.EventEmitter<string>();
    const monitor = new TerminalMonitor(session, row, (text) => output.fire(text), ja);
    const terminal = vscode.window.createTerminal({
      name: `AI Agents: ${row.command || row.processId}`.slice(0, 100),
      iconPath: new vscode.ThemeIcon('terminal'),
      location: vscode.TerminalLocation.Panel,
      isTransient: true,
      pty: {
        onDidWrite: output.event,
        open: () => monitor.open(),
        close: () => monitor.dispose(),
        handleInput: (data: string) => monitor.handleInput(data),
      },
    });
    sessions.set(row.processId, terminal);
    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      listener.dispose(); monitor.dispose(); output.dispose();
      sessions!.delete(row.processId);
      if (!sessions!.size) this.views.delete(session);
    });
    terminal.show();
    return terminal;
  }

  dispose(): void {
    for (const sessions of this.views.values()) for (const terminal of sessions.values()) terminal.dispose();
    this.views.clear();
  }
}
