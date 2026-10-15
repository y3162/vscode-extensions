import * as vscode from 'vscode';
import { AgentsSidebar } from './sidebar.js';
import { errorMessage, type Provider } from './types.js';

let sidebar: AgentsSidebar | undefined;

export function activate(context: vscode.ExtensionContext): { sidebar: AgentsSidebar } {
  const output = vscode.window.createOutputChannel('AI Agents');
  sidebar = new AgentsSidebar(context, output);
  const currentSidebar = sidebar;
  const webviewOptions = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(output,
    vscode.window.registerWebviewViewProvider('ai-agents.chat', sidebar, webviewOptions),
    vscode.window.registerWebviewViewProvider('ai-agents.secondaryChat', sidebar, webviewOptions));

  const register = (name: string, action: () => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`ai-agents.${name}`, async () => {
      try { return await action(); }
      catch (error) {
        output.appendLine(errorMessage(error));
        void vscode.window.showErrorMessage(`AI Agents: ${errorMessage(error)}`);
      }
    }));
  };
  register('open', () => vscode.commands.executeCommand('ai-agents.chat.focus'));
  register('openSecondary', () => vscode.commands.executeCommand('ai-agents.secondaryChat.focus'));
  register('newChat', () => currentSidebar.newChat());
  register('stop', () => currentSidebar.stop());
  register('showHistory', () => currentSidebar.openPanel('history'));
  register('showSettings', () => currentSidebar.openPanel('settings'));
  register('signIn', () => currentSidebar.signIn());
  register('usage', () => currentSidebar.showUsage());
  register('instructions', () => currentSidebar.showInstructions());
  register('apiKey', () => currentSidebar.setApiKey());
  register('addSelection', () => currentSidebar.insertContext('selection'));
  register('addFile', () => currentSidebar.insertContext('file'));
  register('diagnose', () => currentSidebar.showDiagnostics());
  register('selectModel', () => currentSidebar.selectModel());
  register('configureModel', () => currentSidebar.configureModel());
  register('showLogs', () => output.show(true));
  for (const provider of ['cursor', 'codex'] as const) {
    register(provider === 'cursor' ? 'setCursorApiKey' : 'setCodexApiKey', () => setApiKey(provider));
  }
  register('cursorLogin', () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: 'Cursorにログイン', cancellable: true,
  }, async (_progress, token) => {
    const abort = new AbortController();
    const subscription = token.onCancellationRequested(() => abort.abort());
    try {
      const { Cursor } = await import('@cursor/sdk');
      if (token.isCancellationRequested) return;
      await Cursor.auth.login({
        signal: abort.signal,
        openBrowser: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
        apiKeyName: 'VS Code AI Agents',
      });
      await currentSidebar.newChat();
      void vscode.window.showInformationMessage('Cursor SDKにログインしました。');
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally { subscription.dispose(); }
  }));

  async function setApiKey(provider: Provider): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: `${provider === 'cursor' ? 'Cursor' : 'Codex'} API Key`, password: true,
      prompt: 'APIキーを入力（空欄で保存済みキーを削除）', ignoreFocusOut: true,
    });
    if (key === undefined) return;
    const secret = `ai-agents.${provider}.apiKey`;
    if (key.trim()) await context.secrets.store(secret, key.trim());
    else await context.secrets.delete(secret);
    await currentSidebar.newChat();
    void vscode.window.showInformationMessage(key.trim() ? 'APIキーを保存しました。' : '保存済みAPIキーを削除しました。');
  }

  return { sidebar };
}

export async function deactivate(): Promise<void> {
  await sidebar?.dispose();
  sidebar = undefined;
}
