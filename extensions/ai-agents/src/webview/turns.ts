import type { ViewFile, ViewFileIcon, ViewMessage, ViewSubagent, ViewTurnTiming } from '../protocol.js';
import { classifyTool, toolStatus } from '../tool-kind.js';
import type { FileDiffLine, ToolInfo } from '../types.js';

export interface ToolRow {
  id: string;
  name: string;
  kind: ToolInfo['kind'];
  status: ToolInfo['status'];
  target?: string;
  line?: number;
  endLine?: number;
  detail: string;
  exitCode?: number;
}

export interface FileRow {
  path: string;
  name: string;
  kind: string;
  additions?: number;
  deletions?: number;
  preview?: FileDiffLine[];
  icon?: ViewFileIcon;
}

export type Segment =
  | { type: 'thinking'; id: string; text: string; startedAt?: number; durationMs?: number }
  | { type: 'tools'; id: string; tools: ToolRow[] }
  | { type: 'explore'; id: string; tools: ToolRow[] }
  | { type: 'ran'; id: string; tools: ToolRow[] }
  | { type: 'edited'; id: string; tools: ToolRow[] }
  | { type: 'files'; id: string; files: FileRow[] }
  | { type: 'todo'; id: string; items: { content: string; status: string }[] }
  | { type: 'note'; id: string; text: string }
  | { type: 'text'; id: string; text: string; final?: boolean }
  | { type: 'subagent'; id: string; items: ViewSubagent[] };

export interface TurnModel {
  id: string;
  user?: { id: string; text: string; attachments?: string[]; at?: number; canRewind?: boolean; rewindReason?: string };
  log: Segment[];
  answer?: { id: string; text: string };
  errors: { id: string; text: string }[];
  startedAt?: number;
  endedAt?: number;
  waitMs?: number;
  status?: ViewTurnTiming['status'];
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
  // `index` is selected only from a final text segment or a trailing text segment.
  const segment = segments.splice(index, 1)[0] as Extract<Segment, { type: 'text' }>;
  return { id: segment.id, text: segment.text };
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
    ...(file.preview ? { preview: file.preview } : {}),
    ...(file.icon ? { icon: file.icon } : {}),
  };
}

function toolRow(message: ViewMessage): ToolRow | undefined {
  if (message.tool) {
    return {
      id: message.id, name: message.tool.name, kind: message.tool.kind, status: message.tool.status,
      ...(message.tool.target ? { target: message.tool.target } : {}),
      ...(message.tool.line !== undefined ? { line: message.tool.line } : {}),
      ...(message.tool.endLine !== undefined ? { endLine: message.tool.endLine } : {}),
      detail: message.text,
      ...(message.tool.exitCode !== undefined ? { exitCode: message.tool.exitCode } : {}),
    };
  }
  if (message.role !== 'tool' || !message.text.trim()) return undefined;
  const head = message.text.split('\n')[0]!;
  const match = /^([^:\n]{1,40}):\s*(.*)$/.exec(head);
  const name = match?.[2]?.trim() || head;
  return { id: message.id, name, kind: classifyTool(name), status: toolStatus(match?.[1]), target: name, detail: message.text };
}

function segmentFrom(message: ViewMessage): Segment | null {
  if (message.meta?.type === 'plan' || message.meta?.type === 'terminals') return null;
  if (message.meta?.type === 'subagent' && message.meta.subagent) return { type: 'subagent', id: message.id, items: [message.meta.subagent] };
  if (message.meta?.type === 'thinking') return { type: 'thinking', id: message.id, text: message.text, ...(message.at !== undefined ? { startedAt: message.at } : {}) };
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
  if (last?.type === 'files' && segment.type === 'files') {
    for (const file of segment.files) {
      const index = last.files.findIndex((item) => item.path === file.path);
      if (index < 0) { last.files.push(file); continue; }
      const previous = last.files[index]!;
      last.files[index] = {
        ...previous,
        ...file,
        ...(file.additions === undefined && previous.additions !== undefined ? { additions: previous.additions } : {}),
        ...(file.deletions === undefined && previous.deletions !== undefined ? { deletions: previous.deletions } : {}),
        ...(!file.preview?.length && previous.preview?.length ? { preview: previous.preview } : {}),
      };
    }
    return;
  }
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
    const timing = timings.find((item) => item.id === id);
    closeThinking(segments, timing?.endedAt ?? (!busy && !pending ? endedAt : undefined));
    const answer = takeAnswer(segments);
    const log = presentActivity(segments);
    turns.push({
      id, ...(user ? { user } : {}), log,
      ...(answer ? { answer } : {}),
      errors,
      ...(timing?.startedAt !== undefined || startedAt !== undefined ? { startedAt: timing?.startedAt ?? startedAt } : {}),
      ...(timing?.endedAt !== undefined || endedAt !== undefined ? { endedAt: timing?.endedAt ?? endedAt } : {}),
      ...(timing ? { waitMs: timing.waitMs } : {}),
      ...(timing ? { status: timing.status } : {}),
      done: false,
    });
  };
  // Retry attempts retain one user bubble, even if the attempt was appended after another turn.
  const order: string[] = [];
  const groups = new Map<string, ViewMessage[]>();
  let current = '';
  for (const message of messages) {
    if (message.subagentId) continue;
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
      user = {
        id: message.id, text: message.text,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...(message.at !== undefined ? { at: message.at } : {}),
        ...(message.canRewind !== undefined ? { canRewind: message.canRewind } : {}),
        ...(message.rewindReason ? { rewindReason: message.rewindReason } : {}),
      };
      segments = [];
      errors = [];
      startedAt = message.at;
      endedAt = message.at;
      continue;
    }
    if (!id) id = `pre-${message.id}`;
    if (message.at !== undefined) {
      if (message.meta?.type !== 'thinking') closeThinking(segments, message.at);
      endedAt = message.at;
    }
    if (message.role === 'error') { errors.push({ id: message.id, text: message.text }); continue; }
    const segment = segmentFrom(message);
    if (segment) pushSegment(segments, segment);
  }
  finish();
  return turns.map((turn, index) => ({ ...turn, done: index < turns.length - 1 || (!busy && !pending) }));
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

type BatchKind = 'explore' | 'ran' | 'edited';

function batchKind(tool: ToolRow): BatchKind | undefined {
  if (tool.kind === 'read' || tool.kind === 'search') return 'explore';
  if (tool.kind === 'shell') return 'ran';
  if (tool.kind === 'edit') return 'edited';
  return undefined;
}

function presentActivity(segments: Segment[]): Segment[] {
  const edited = new Set<string>();
  for (const segment of segments) {
    if (segment.type !== 'files') continue;
    for (const file of segment.files) edited.add(pathKey(file.path));
  }
  const pruned = segments.flatMap((segment): Segment[] => {
    if (segment.type === 'thinking') return segment.text.trim() ? [segment] : [];
    if (segment.type !== 'tools') return [segment];
    const tools = segment.tools.filter((tool) => !(tool.kind === 'edit' && tool.target && edited.has(pathKey(tool.target))));
    return tools.length ? [{ ...segment, tools }] : [];
  });
  const grouped: Segment[] = [];
  let batch: ToolRow[] = [];
  let batchKindName: BatchKind | undefined;
  let batchId = '';
  const flush = () => {
    if (!batch.length || !batchKindName) { batch = []; batchKindName = undefined; return; }
    grouped.push({ type: batchKindName, id: batchId, tools: batch });
    batch = [];
    batchKindName = undefined;
  };
  for (const segment of pruned) {
    if (segment.type !== 'tools') { flush(); grouped.push(segment); continue; }
    for (const tool of segment.tools) {
      const next = batchKind(tool);
      if (!next) {
        flush();
        grouped.push({ type: 'tools', id: tool.id, tools: [tool] });
        continue;
      }
      if (batchKindName && batchKindName !== next) flush();
      if (!batch.length) { batchId = tool.id; batchKindName = next; }
      batch.push(tool);
    }
  }
  flush();
  return grouped;
}

/** Elapsed work time in milliseconds. Missing or sub-millisecond spans are omitted. */
export function workElapsedMs(turn: Pick<TurnModel, 'startedAt' | 'endedAt' | 'status'>): number | undefined {
  if (turn.status === 'unknown') return undefined;
  if (turn.startedAt === undefined || turn.endedAt === undefined) return undefined;
  const elapsed = turn.endedAt - turn.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 1) return undefined;
  return elapsed;
}

function closeThinking(segments: Segment[], endAt?: number): void {
  const last = segments.at(-1);
  if (last?.type === 'thinking' && last.durationMs === undefined && last.startedAt !== undefined
    && endAt !== undefined && Number.isFinite(endAt) && endAt >= last.startedAt) {
    last.durationMs = endAt - last.startedAt;
  }
}
