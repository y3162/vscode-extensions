import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isInsideWorkspace } from './change-review.js';

const textExtensions = new Set(['.md', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.css', '.scss', '.html', '.vue', '.svelte', '.yml', '.yaml', '.toml', '.xml', '.sql', '.sh', '.zsh', '.css', '.c', '.h', '.cpp', '.cs', '.kt', '.swift']);
const skipDirectories = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage']);

export interface SlashCommand {
  name: string;
  title: string;
  description: string;
  kind: 'command' | 'skill' | 'builtin';
  body?: string;
}

export function resolveInside(cwd: string, token: string): string | undefined {
  if (!token || token.includes('\0')) return undefined;
  const root = path.resolve(cwd);
  const target = path.resolve(root, token);
  if (!isInsideWorkspace(target, [root])) return undefined;
  return target;
}

async function staysInside(cwd: string, target: string): Promise<boolean> {
  const root = path.resolve(cwd);
  const realRoot = await realpath(root).catch(() => root);
  try {
    const realTarget = await realpath(target);
    return isInsideWorkspace(target, [root]) && isInsideWorkspace(realTarget, [realRoot]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    return isInsideWorkspace(target, [root]);
  }
}

async function readCapped(target: string, maxChars: number): Promise<string> {
  const info = await stat(target);
  if (!info.isFile() || info.size > maxChars * 4) return '';
  const bytes = await readFile(target);
  if (bytes.includes(0)) return '';
  const text = bytes.toString('utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

async function folderContext(cwd: string, target: string): Promise<string> {
  const files: string[] = [];
  const walk = async (directory: string, depth: number) => {
    if (files.length >= 20 || depth > 3) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= 20) return;
      if (skipDirectories.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (!await staysInside(cwd, full)) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  await walk(target, 0);
  if (!files.length) {
    const names = await readdir(target);
    return names.slice(0, 50).join('\n');
  }
  const blocks: string[] = [];
  for (const file of files) {
    const body = await readCapped(file, 8_000);
    if (!body) continue;
    blocks.push(`### ${path.relative(cwd, file)}\n${body}`);
  }
  return blocks.join('\n\n');
}

export function parseFrontmatter(source: string): { title: string; description: string; body: string } {
  if (!source.startsWith('---\n')) return { title: '', description: '', body: source };
  const end = source.indexOf('\n---\n', 4);
  if (end < 0) return { title: '', description: '', body: source };
  const header = source.slice(4, end);
  const body = source.slice(end + 5);
  const read = (key: string) => header.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { title: read('name'), description: read('description'), body };
}

function referencePattern(): RegExp {
  return /@(?:"([^"]+)"|([^\s@]+))/g;
}

export async function expandPrompt(prompt: string, cwd: string, commands: SlashCommand[] = []): Promise<string> {
  const blocks: string[] = [];
  const references = [...prompt.matchAll(referencePattern())];
  for (const match of references) {
    // The reference pattern requires one of its two alternatives, so one capture is always present.
    const token = match[1] ?? match[2]!;
    const target = resolveInside(cwd, token);
    if (!target || !await staysInside(cwd, target)) {
      if (token.includes('/') || token.includes(path.sep)) blocks.push(`--- Context: ${token} ---\n(missing or outside the workspace)`);
      continue;
    }
    const info = await stat(target).catch(() => undefined);
    if (!info) {
      blocks.push(`--- Context: ${token} ---\n(missing)`);
      continue;
    }
    if (info.isDirectory()) {
      blocks.push(`--- Context: ${token}/ ---\n${await folderContext(cwd, target)}`);
      continue;
    }
    const body = await readCapped(target, 40_000);
    blocks.push(`--- Context: ${token} ---\n\`\`\`\n${body}\n\`\`\``);
  }
  let expanded = prompt;
  const slash = /(?:^|\n)\/([a-z0-9][\w-]*)\b([^\n]*)/gi;
  for (const match of expanded.matchAll(slash)) {
    const name = match[1]?.toLowerCase();
    if (!name || ['clear', 'compact', 'review', 'diagnostics', 'diff', 'terminal'].includes(name)) continue;
    const command = commands.find((item) => item.name.toLowerCase() === name);
    if (!command?.body) continue;
    blocks.push(`--- ${command.kind}: ${command.name} ---\n${command.body.slice(0, 20_000)}`);
  }
  if (!blocks.length) return prompt;
  const prefix = blocks.join('\n\n');
  const combined = `${prefix}\n\n${expanded}`;
  return combined.length > 180_000 ? `${combined.slice(0, 180_000)}\n…(context truncated)` : combined;
}

export function builtinCommand(prompt: string): { name: string; rest: string } | undefined {
  const match = prompt.trim().match(/^\/([a-z0-9][\w-]*)(?:\s+([\s\S]*))?$/i);
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), rest: match[2]?.trim() ?? '' };
}

export function suggestionToken(prompt: string, caret: number): { kind: 'file' | 'slash'; query: string; start: number } | undefined {
  const until = prompt.slice(0, caret);
  const file = until.match(/(^|[\s])@([^\s@]*)$/);
  if (file?.[2] !== undefined) return { kind: 'file', query: file[2], start: until.length - file[2].length - 1 };
  const slash = until.match(/(^|\n)\/([\w-]*)$/);
  if (slash?.[2] !== undefined) return { kind: 'slash', query: slash[2], start: until.length - slash[2].length - 1 };
  return undefined;
}
