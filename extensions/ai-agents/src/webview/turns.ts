import type { ViewFile, ViewMessage, ViewSubagent, ViewTurnTiming } from '../protocol.js';
import { classifyTool, toolStatus } from '../tool-kind.js';
import type { ToolInfo } from '../types.js';

export interface ToolRow {
  id: string;
  name: string;
  kind: ToolInfo['kind'];
  status: ToolInfo['status'];
  target?: string;
  detail: string;
  exitCode?: number;
}

export interface FileRow {
  path: string;
  name: string;
  kind: string;
  additions?: number;
  deletions?: number;
}

export type Segment =
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tools'; id: string; tools: ToolRow[] }
  | { type: 'files'; id: string; files: FileRow[] }
  | { type: 'todo'; id: string; items: { content: string; status: string }[] }
  | { type: 'note'; id: string; text: string }
  | { type: 'text'; id: string; text: string; final?: boolean }
  | { type: 'subagent'; id: string; items: ViewSubagent[] };

export interface TurnModel {
  id: string;
  user?: { id: string; text: string; attachments?: string[]; at?: number };
  log: Segment[];
  answer?: { id: string; text: string };
  errors: { id: string; text: string }[];
  startedAt?: number;
  endedAt?: number;
  waitMs?: number;
  done: boolean;
}

function takeAnswer(segments: Segment[]): { id: string; text: string } | undefined {
  let finalIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment?.type === 'text' && segment.final) { finalIndex = index; break; }
  }
  const index = finalIndex >= 0 ? finalIndex : segments.at(-1)?.type === 'text' ? segments.length - 1 : -1;
  if (index < 0) return undefined;
  const [segment] = segments.splice(index, 1);
  return segment?.type === 'text' ? { id: segment.id, text: segment.text } : undefined;
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.at(-1) || file;
}

function fileRow(file: ViewFile): FileRow {
  return {
    path: file.path,
    name: basename(file.path),
    kind: file.kind,
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
  };
}

function toolRow(message: ViewMessage): ToolRow | undefined {
  if (message.tool) {
    return {
      id: message.id, name: message.tool.name, kind: message.tool.kind, status: message.tool.status,
      ...(message.tool.target ? { target: message.tool.target } : {}),
      detail: message.text,
      ...(message.tool.exitCode !== undefined ? { exitCode: message.tool.exitCode } : {}),
    };
  }
  if (message.role !== 'tool' || !message.text.trim()) return undefined;
  const head = message.text.split('\n')[0] ?? message.text;
  const match = /^([^:\n]{1,40}):\s*(.*)$/.exec(head);
  const name = match?.[2]?.trim() || head;
  return { id: message.id, name, kind: classifyTool(name), status: toolStatus(match?.[1]), target: name, detail: message.text };
}

function segmentFrom(message: ViewMessage): Segment | null {
  if (message.meta?.type === 'plan' || message.meta?.type === 'terminals') return null;
  if (message.meta?.type === 'subagent' && message.meta.subagent) return { type: 'subagent', id: message.id, items: [message.meta.subagent] };
  if (message.meta?.type === 'thinking') return { type: 'thinking', id: message.id, text: message.text };
  if (message.meta?.type === 'todo' && message.meta.todos?.length) return { type: 'todo', id: message.id, items: message.meta.todos };
  if (message.meta?.type === 'files' && message.meta.files?.length) return { type: 'files', id: message.id, files: message.meta.files.map(fileRow) };
  if (message.meta?.type === 'image' && message.meta.imagePath) return { type: 'note', id: message.id, text: message.meta.imagePath };
  if (message.meta?.type === 'task') return { type: 'note', id: message.id, text: message.meta.task || message.text };
  if (message.role === 'assistant' && message.text) return { type: 'text', id: message.id, text: message.text, ...(message.final ? { final: true } : {}) };
  if (message.role === 'tool' || message.tool) {
    const row = toolRow(message);
    return row ? { type: 'tools', id: message.id, tools: [row] } : null;
  }
  if (message.role === 'status' && message.text.trim()) return { type: 'note', id: message.id, text: message.text };
  return null;
}

function pushSegment(list: Segment[], segment: Segment): void {
  const last = list.at(-1);
  if (last?.type === 'tools' && segment.type === 'tools') { last.tools.push(...segment.tools); return; }
  if (last?.type === 'files' && segment.type === 'files') { last.files.push(...segment.files); return; }
  if (last?.type === 'subagent' && segment.type === 'subagent') { last.items.push(...segment.items); return; }
  if (last?.type === 'thinking' && segment.type === 'thinking') {
    last.text = segment.text.startsWith(last.text) ? segment.text : `${last.text}${last.text.endsWith(segment.text) ? '' : `\n${segment.text}`}`;
    return;
  }
  if (last?.type === 'text' && segment.type === 'text') { last.text = `${last.text}\n\n${segment.text}`; last.id = segment.id; return; }
  list.push(segment);
}

export function buildTurns(messages: readonly ViewMessage[], busy: boolean, pending: boolean, timings: readonly ViewTurnTiming[] = []): TurnModel[] {
  const turns: TurnModel[] = [];
  let segments: Segment[] = [];
  let errors: { id: string; text: string }[] = [];
  let user: TurnModel['user'];
  let id = '';
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  const finish = () => {
    if (!id) return;
    const answer = takeAnswer(segments);
    const timing = timings.find((item) => item.id === id);
    turns.push({
      id, ...(user ? { user } : {}), log: segments,
      ...(answer ? { answer } : {}),
      errors,
      ...(timing?.startedAt !== undefined || startedAt !== undefined ? { startedAt: timing?.startedAt ?? startedAt } : {}),
      ...(timing?.endedAt !== undefined || endedAt !== undefined ? { endedAt: timing?.endedAt ?? endedAt } : {}),
      ...(timing ? { waitMs: timing.waitMs } : {}),
      done: false,
    });
  };
  // Retry attempts retain one user bubble, even if the attempt was appended after another turn.
  const order: string[] = [];
  const groups = new Map<string, ViewMessage[]>();
  let current = '';
  for (const message of messages) {
    if (message.role === 'user') current = message.id;
    const key = message.turnId ?? current;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(message);
  }
  const ordered = order.flatMap((key) => groups.get(key)!);
  for (const message of ordered) {
    if (message.role === 'user') {
      finish();
      id = message.id;
      user = { id: message.id, text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(message.at !== undefined ? { at: message.at } : {}) };
      segments = [];
      errors = [];
      startedAt = message.at;
      endedAt = message.at;
      continue;
    }
    if (!id) id = `pre-${message.id}`;
    if (message.at !== undefined) endedAt = message.at;
    if (message.role === 'error') { errors.push({ id: message.id, text: message.text }); continue; }
    const segment = segmentFrom(message);
    if (segment) pushSegment(segments, segment);
  }
  finish();
  return turns.map((turn, index) => ({ ...turn, done: index < turns.length - 1 || (!busy && !pending) }));
}
