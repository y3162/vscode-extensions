import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { parseFrontmatter, type SlashCommand } from './context-text.js';
import { isInsideWorkspace } from './change-review.js';

const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage']);
let slashCache: { at: number; cwd: string; commands: SlashCommand[] } | undefined;
const terminalCommands: string[] = [];

export function watchTerminals(subscriptions: vscode.Disposable[]): void {
  const source = vscode.window as typeof vscode.window & {
    onDidEndTerminalShellExecution?: (listener: (event: {
      exitCode: number | undefined;
      execution: { commandLine: { value?: string } | string };
    }) => void) => vscode.Disposable;
  };
  if (!source.onDidEndTerminalShellExecution) return;
  subscriptions.push(source.onDidEndTerminalShellExecution((event) => {
    const command = typeof event.execution.commandLine === 'string' ? event.execution.commandLine : event.execution.commandLine.value;
    if (!command) return;
    terminalCommands.unshift(`${command} (exit ${event.exitCode ?? 'unknown'})`);
    if (terminalCommands.length > 20) terminalCommands.pop();
  }));
}

export function recentTerminalText(): string {
  if (!terminalCommands.length) return 'VS Codeはターミナルの画面出力を拡張機能へ渡さないため、シェル統合で観測できた最近のコマンドだけを添付します。\n(none yet)';
  return `VS Codeはターミナルの画面出力を拡張機能へ渡さないため、シェル統合で観測できた最近のコマンドだけを添付します。\n${terminalCommands.slice(0, 10).join('\n')}`;
}

export async function searchWorkspace(cwd: string, query: string): Promise<{ label: string; description: string; token: string }[]> {
  const safeQuery = query.replace(/[\\*?[\]{}]/g, '');
  const pattern = safeQuery ? `**/*${safeQuery}*` : '*';
  const ignored = '**/{node_modules,.git,dist,out,build,.next,coverage}/**';
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(cwd), pattern), ignored, safeQuery ? 80 : 30);
  const items = new Map<string, { label: string; description: string; token: string }>();
  const add = (token: string, label: string) => {
    if (!token || items.has(token) || !isInsideWorkspace(path.resolve(cwd, token), [cwd])) return;
    items.set(token, { token, label, description: path.dirname(token) === '.' ? '' : path.dirname(token) });
  };
  for (const uri of uris) {
    if (uri.scheme !== 'file' || !isInsideWorkspace(uri.fsPath, [cwd])) continue;
    const token = path.relative(cwd, uri.fsPath);
    add(token, path.basename(token));
    const parent = path.dirname(token);
    if (parent !== '.') add(parent, path.basename(parent));
  }
  if (!safeQuery) {
    const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      add(entry.isDirectory() ? `${entry.name}/` : entry.name, entry.name);
    }
  }
  return [...items.values()].sort((left, right) => rank(safeQuery, left.label) - rank(safeQuery, right.label) || left.token.localeCompare(right.token)).slice(0, 40);
}

function rank(query: string, label: string): number {
  if (!query) return 0;
  const name = label.toLowerCase();
  const needle = query.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return 3;
}

async function commandsFrom(root: string, scope: string): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  const commandDir = path.join(root, '.cursor', 'commands');
  const files = await readdir(commandDir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const source = await readFile(path.join(commandDir, file), 'utf8').catch(() => '');
    const parsed = parseFrontmatter(source);
    const name = parsed.title || path.basename(file, '.md');
    commands.push({ name, title: name, description: parsed.description || scope, kind: 'command', body: parsed.body });
  }
  for (const skills of [path.join(root, '.cursor', 'skills'), path.join(root, '.cursor', 'skills-cursor'), path.join(root, '.codex', 'skills')]) {
    const dirs = await readdir(skills, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillPath = path.join(skills, dir.name, 'SKILL.md');
      const source = await readFile(skillPath, 'utf8').catch(() => '');
      if (!source) continue;
      const parsed = parseFrontmatter(source);
      commands.push({ name: parsed.title || dir.name, title: parsed.title || dir.name, description: parsed.description || 'skill', kind: 'skill', body: parsed.body });
    }
  }
  return commands;
}

export async function workspaceCommands(cwd: string): Promise<SlashCommand[]> {
  const now = Date.now();
  if (slashCache && slashCache.cwd === cwd && now - slashCache.at < 30_000) return slashCache.commands;
  const builtins: SlashCommand[] = [
    { name: 'clear', title: 'clear', description: 'Start a new chat', kind: 'builtin' },
    { name: 'compact', title: 'compact', description: 'Compact the context', kind: 'builtin' },
    { name: 'review', title: 'review', description: 'Review changes', kind: 'builtin' },
    { name: 'diagnostics', title: 'diagnostics', description: 'Attach problems', kind: 'builtin' },
    { name: 'diff', title: 'diff', description: 'Attach git diff', kind: 'builtin' },
    { name: 'terminal', title: 'terminal', description: 'Attach recent terminal commands', kind: 'builtin' },
  ];
  const discovered = [...await commandsFrom(cwd, 'workspace'), ...await commandsFrom(homedir(), 'user')];
  const unique = new Map<string, SlashCommand>();
  for (const command of [...builtins, ...discovered]) if (!unique.has(command.name)) unique.set(command.name, command);
  slashCache = { at: now, cwd, commands: [...unique.values()] };
  return slashCache.commands;
}

export async function gitSummary(cwd: string): Promise<string> {
  const run = (args: string[]) => new Promise<string>((resolve) => {
    execFile('git', args, { cwd, timeout: 8000, maxBuffer: 1_000_000 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
  const status = await run(['status', '--short']);
  const diff = await run(['diff', '--stat']);
  const patch = (await run(['diff'])).slice(0, 60_000);
  return `git status:\n${status || '(clean)'}\n\ngit diff --stat:\n${diff || '(none)'}\n\n${patch}`;
}

export function problemsText(cwd: string): string {
  const lines: string[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file' || !isInsideWorkspace(uri.fsPath, [cwd])) continue;
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
      const level = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      lines.push(`${path.relative(cwd, uri.fsPath)}:${diagnostic.range.start.line + 1}: ${level}: ${diagnostic.message}`);
      if (lines.length >= 50) return lines.join('\n');
    }
  }
  return lines.join('\n') || 'No errors or warnings.';
}

export function activeFileToken(cwd: string): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file' || !isInsideWorkspace(editor.document.uri.fsPath, [cwd])) return undefined;
  return path.relative(cwd, editor.document.uri.fsPath);
}

export function selectionBlock(cwd: string): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') return undefined;
  if (!isInsideWorkspace(editor.document.uri.fsPath, [cwd])) return undefined;
  const relative = path.relative(cwd, editor.document.uri.fsPath);
  const text = editor.document.getText(editor.selection).slice(0, 20_000);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  return `--- Context: selection ${relative}:${start}-${end} ---\n\`\`\`\n${text}\n\`\`\``;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then((info) => info.isFile() || info.isDirectory()).catch(() => false);
}

export async function instructionSummary(cwd: string): Promise<string> {
  const lines: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    if (await exists(path.join(cwd, name))) lines.push(name);
  }
  const rules = path.join(cwd, '.cursor', 'rules');
  const ruleFiles = await readdir(rules).catch(() => []);
  if (ruleFiles.length) lines.push(`.cursor/rules: ${ruleFiles.slice(0, 30).join(', ')}`);
  const commands = await workspaceCommands(cwd);
  const skills = commands.filter((command) => command.kind === 'skill').map((command) => command.name);
  if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
  for (const file of [path.join(cwd, '.cursor', 'mcp.json'), path.join(homedir(), '.cursor', 'mcp.json')]) {
    const names = await readFile(file, 'utf8').then((source) => {
      const parsed = JSON.parse(source) as { mcpServers?: Record<string, unknown> };
      return Object.keys(parsed.mcpServers ?? {});
    }).catch(() => []);
    if (names.length) lines.push(`MCP (${path.basename(path.dirname(file))}): ${names.join(', ')}`);
  }
  return lines.join('\n') || 'No AGENTS.md, rules, skills, or MCP config found.';
}
