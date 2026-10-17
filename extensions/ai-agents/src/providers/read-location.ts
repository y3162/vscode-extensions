export interface ReadLocation {
  path?: string;
  line?: number;
  endLine?: number;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathAndRange(value: string | undefined): ReadLocation {
  if (!value) return {};
  const match = /\s+L(\d+)(?:\s*[-–]\s*L?(\d+))?\s*$/i.exec(value);
  const file = (match ? value.slice(0, match.index) : value).trim().replace(/^['"`]|['"`]$/g, '');
  return {
    ...(file ? { path: file } : {}),
    ...(match ? { line: positiveInteger(match[1]), ...(match[2] ? { endLine: positiveInteger(match[2]) } : {}) } : {}),
  };
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  return text(record.path) ?? text(record.filePath) ?? text(record.file_path) ?? text(record.filename) ?? text(record.uri);
}

function inputLine(input: unknown, keys: string[]): number | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = positiveInteger(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pathFromName(name: string): string | undefined {
  const match = /^(?:read|open)\s+(.+)$/i.exec(name.trim());
  if (!match) return undefined;
  const candidate = pathAndRange(match[1]!).path;
  if (!candidate || /^(?:the\s+)?files?$/i.test(candidate)) return undefined;
  return candidate;
}

/** Extract a file and optional line span from structured Read arguments or labels like "Read README.md L1-51". */
export function readLocation(name: string, target?: string, input?: unknown): ReadLocation {
  const fromTarget = pathAndRange(target);
  const fromName = pathAndRange(name);
  const structuredPath = inputPath(input);
  const namedPath = pathFromName(name);
  const line = inputLine(input, ['line', 'startLine', 'start_line', 'fromLine', 'from_line']) ?? fromName.line ?? fromTarget.line;
  const endLine = inputLine(input, ['endLine', 'end_line', 'toLine', 'to_line']) ?? fromName.endLine ?? fromTarget.endLine;
  const file = structuredPath ?? fromTarget.path ?? namedPath;
  return {
    ...(file ? { path: file } : {}),
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
  };
}
