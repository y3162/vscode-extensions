import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentsSidebar } from '../../src/sidebar.js';
import { ExtensionContext, Uri, window, workspace } from './vscode-stub.js';

export interface HarnessPaths {
  root: string;
  workspacePath: string;
  context: ExtensionContext;
}

export interface Harness extends HarnessPaths {
  sidebar: AgentsSidebar;
  output: ReturnType<typeof window.createOutputChannel>;
}

export function prepareHarnessRoot(): HarnessPaths {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-agents-vscode-'));
  const workspacePath = path.join(root, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(path.join(root, 'storage'), { recursive: true });
  mkdirSync(path.join(root, 'global'), { recursive: true });
  mkdirSync(path.join(root, 'extension'), { recursive: true });
  const context = new ExtensionContext(root);
  const agents = workspace.configuration['ai-agents'] ?? {};
  if (!agents['codex.executablePath']) agents['codex.executablePath'] = '/usr/bin/false';
  if (!agents['cursor.agentPath'] || agents['cursor.agentPath'] === 'agent') agents['cursor.agentPath'] = '/usr/bin/false';
  workspace.configuration['ai-agents'] = agents;
  workspace.workspaceFolders = [{ name: 'workspace', uri: Uri.file(workspacePath), index: 0 }];
  workspace.isTrusted = true;
  return { root, workspacePath, context };
}

export function openSidebar(prepare?: (paths: HarnessPaths) => void, options?: { folders?: boolean }): Harness {
  const paths = prepareHarnessRoot();
  if (options?.folders === false) workspace.workspaceFolders = [];
  prepare?.(paths);
  const output = window.createOutputChannel('AI Agents');
  const sidebar = new AgentsSidebar(paths.context as never, output as never);
  return { ...paths, sidebar, output };
}

export interface TestView {
  visible: boolean;
  viewType: string;
  description?: string;
  badge?: { value: number; tooltip?: string };
  messages: Array<Record<string, unknown>>;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void };
    asWebviewUri: (uri: { fsPath?: string }) => { toString(): string };
  };
  onDidDispose: (listener: () => void) => { dispose(): void };
  receive: (message: unknown) => void;
  dispose: () => void;
}

export function createView(viewType = 'ai-agents.chat'): TestView {
  let listener: ((message: unknown) => void) | undefined;
  const disposeListeners: Array<() => void> = [];
  const messages: Array<Record<string, unknown>> = [];
  return {
    visible: true,
    viewType,
    messages,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      postMessage: async (message: unknown) => {
        messages.push(message as Record<string, unknown>);
        return true;
      },
      onDidReceiveMessage: (next) => {
        listener = next;
        return { dispose: () => { if (listener === next) listener = undefined; } };
      },
      asWebviewUri: (uri) => ({ toString: () => `vscode-webview:${uri.fsPath ?? ''}` }),
    },
    onDidDispose: (next) => {
      disposeListeners.push(next);
      return { dispose() {} };
    },
    receive: (message) => { listener?.(message); },
    dispose: () => { for (const next of disposeListeners) next(); },
  };
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
