import type { AgentModel, AgentSession, AgentUpdate, FileChange, TodoEntry } from '../types.js';
import { redactSecrets } from '../types.js';
import { classifyTool } from '../tool-kind.js';
import { agentLaunch } from './codex-binary.js';
import { readCliText, readJsonEvents, spawnCli, type CliSpawn } from './cli-jsonl.js';
import { AssistantSegments } from './segments.js';
import type { SessionOptions } from './session-options.js';

export function cursorCliModelArg(model: string, params?: { id: string; value: string }[]): string | undefined {
  const id = model.trim();
  if (!id) return undefined;
  const pairs = (params ?? []).flatMap((param) => param.id && param.value ? [`${param.id}=${param.value}`] : []);
  return pairs.length ? `${id}[${pairs.join(',')}]` : id;
}

export function cursorCliArgs(options: {
  mode?: string;
  model?: string;
  modelParams?: { id: string; value: string }[];
  sandbox?: string;
  additionalDirectories?: string[];
  resumeId?: string;
  prompt: string;
}): string[] {
  const model = cursorCliModelArg(options.model ?? '', options.modelParams);
  return [
    '--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust',
    '--sandbox', options.sandbox === 'disabled' ? 'disabled' : 'enabled',
    ...(options.mode === 'plan' || options.mode === 'ask' ? ['--mode', options.mode] : []),
    ...(model ? ['--model', model] : []),
    ...(options.additionalDirectories ?? []).flatMap((directory) => ['--add-dir', directory]),
    ...(options.resumeId ? ['--resume', options.resumeId] : []),
    options.prompt,
  ];
}

export function parseCursorCliModels(output: string): AgentModel[] {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const models: AgentModel[] = [];
  const seen = new Set<string>();
  for (const line of plain.split('\n')) {
    const trimmed = line.trim();
    const match = /^([A-Za-z0-9_.:/=-][A-Za-z0-9_.:/=[\]-]*)(?:\s+-\s+(.+?))?(?:\s+\(([^)]*)\))?\s*$/.exec(trimmed);
    if (!match) continue;
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const notes = match[3] ?? '';
    models.push({
      id,
      label: match[2]?.trim() || id,
      ...(notes.split(',').some((note) => note.trim() === 'default') ? { isDefault: true } : {}),
    });
  }
  return models;
}

export async function listCursorCliModels(options: {
  cwd?: string;
  apiKey?: string;
  agentPath?: string;
  signal?: AbortSignal;
}, spawn: CliSpawn = spawnCli): Promise<AgentModel[]> {
  const signal = options.signal ?? AbortSignal.timeout(20000);
  const launch = agentLaunch(options.agentPath, ['--list-models'], options.cwd);
  const run = spawn({
    command: launch.command,
    args: launch.args,
    cwd: options.cwd,
    env: { ...process.env, ...(options.apiKey ? { CURSOR_API_KEY: options.apiKey } : {}) },
  });
  const stdout = await readCliText(run, signal);
  const models = parseCursorCliModels(stdout);
  if (!models.length) throw new Error('Cursor CLI のモデル一覧が空です。');
  return models;
}

export async function createCursorCliSession(options: SessionOptions, spawn: CliSpawn = spawnCli): Promise<AgentSession> {
  let sessionId = options.resumeId;
  let model = options.model;
  let modelParams = options.modelParams;
  let mode = options.mode ?? 'agent';
  let active: CliRunKill | undefined;
  const identify = (title: string) => {
    if (!sessionId) return;
    options.onIdentity?.({
      id: sessionId, title, titleSource: 'local', updatedAt: new Date().toISOString(), provider: 'cursor', cwd: options.cwd,
    });
  };
  return {
    get sessionId() { return sessionId; },
    setModel(selection) {
      model = selection.model;
      modelParams = selection.modelParams;
    },
    async setMode(next) { mode = next; },
    async run(prompt, signal, emit, extras, turn) {
      if (extras?.images?.length) throw new Error('Cursor CLI の print モードは画像添付に対応していません。');
      const requestedMode = turn?.mode ?? mode;
      const selection = turn?.selection;
      const args = cursorCliArgs({
        mode: requestedMode,
        model: selection?.model ?? model,
        modelParams: selection?.modelParams ?? modelParams,
        sandbox: options.sandbox,
        additionalDirectories: options.additionalDirectories,
        resumeId: sessionId,
        prompt,
      });
      const launch = agentLaunch(options.agentPath, args, options.cwd);
      const key = options.apiKey || process.env.CURSOR_API_KEY;
      const run = spawn({
        command: launch.command,
        args: launch.args,
        cwd: options.cwd,
        env: { ...process.env, ...(key ? { CURSOR_API_KEY: key } : {}) },
      });
      active = run;
      const segments = new AssistantSegments();
      let sawPlan = false;
      const remember = (id: unknown) => {
        if (!sessionId && typeof id === 'string' && id) {
          sessionId = id;
          identify(prompt.slice(0, 80) || 'Cursor');
        }
      };
      try {
        await readJsonEvents(run, signal, (event) => {
          const record = asRecord(event);
          if (!record || typeof record.type !== 'string') return;
          remember(record.session_id);
          if (record.type === 'assistant') {
            const text = assistantText(record);
            const segment = text ? segments.push(text) : undefined;
            if (segment && !signal.aborted) emit({ id: segment.id, role: 'assistant', text: segment.text });
            return;
          }
          if (record.type === 'tool_call') {
            segments.interrupt();
            const update = cursorCliTool(record);
            if (!update || signal.aborted) return;
            if (update.meta?.type === 'plan') sawPlan = true;
            emit(update);
            return;
          }
          if (record.type === 'result') {
            remember(record.session_id);
            if (record.is_error === true) {
              const message = typeof record.result === 'string' && record.result ? record.result : 'Cursor CLI の実行に失敗しました。';
              throw new Error(redactSecrets(message));
            }
            if (!segments.fullText() && typeof record.result === 'string' && record.result && !signal.aborted) {
              const segment = segments.push(record.result);
              if (segment) emit({ id: segment.id, role: 'assistant', text: segment.text });
            }
          }
        });
        const planText = segments.fullText().trim();
        if (requestedMode === 'plan' && !sawPlan && planText && !signal.aborted) {
          emit({ id: 'plan-text', role: 'status', text: planText, meta: { type: 'plan', plan: { markdown: planText, source: 'assistant-text' } } });
        }
        identify(prompt.slice(0, 80) || 'Cursor');
      } finally {
        if (active === run) active = undefined;
      }
    },
    async dispose() { active?.kill(); },
  };
}

interface CliRunKill { kill(): void }

function cursorCliTool(event: Record<string, unknown>): AgentUpdate | undefined {
  const payload = toolPayload(event.tool_call);
  if (!payload) return undefined;
  const name = payload.name.replace(/ToolCall$/, '') || payload.name;
  const callId = typeof event.call_id === 'string' && event.call_id ? event.call_id : `tool-${name}`;
  const status = event.subtype === 'started' ? 'running' as const : 'completed' as const;
  const target = firstString(payload.args, ['command', 'path', 'file_path', 'target_file', 'pattern', 'query', 'glob_pattern']);
  if (name === 'createPlan') {
    const plan = firstString(payload.args, ['plan', 'planMarkdown', 'markdown']);
    if (!plan?.trim()) return { id: callId, role: 'tool', text: `${status}: ${name}`, tool: { kind: 'other', name, status } };
    return { id: callId, role: 'status', text: plan, meta: { type: 'plan', plan: { markdown: plan, source: 'assistant-text' } } };
  }
  const todos = name === 'updateTodos' ? todoEntries(payload.args.todos) : [];
  if (todos.length) return { id: callId, role: 'status', text: todos.map((todo) => `${todo.status}: ${todo.content}`).join('\n'), meta: { type: 'todo', todos } };
  const output = redactSecrets(shellOutput(payload.result)).slice(0, 2000);
  const text = [status === 'running' ? 'running' : 'completed', name, target, output].filter(Boolean).join('\n');
  const kind = classifyTool(name, target ?? '');
  const file = fileChange(name, payload.args, payload.result);
  return {
    id: callId,
    role: 'tool',
    text,
    tool: { kind, name, status, ...(target ? { target } : {}) },
    ...(file ? { meta: { type: 'files' as const, files: [file] } } : {}),
  };
}

function fileChange(name: string, args: Record<string, unknown>, result: unknown): FileChange | undefined {
  if (name !== 'edit' && name !== 'write' && name !== 'delete') {
    return undefined;
  }
  const path = firstString(args, ['path', 'file_path', 'target_file']) ?? firstString(asRecord(result) ?? {}, ['path', 'file_path']);
  if (!path) {
    return undefined;
  }
  const diff = firstString(args, ['diff', 'diffString']) ?? firstString(asRecord(result) ?? {}, ['diff', 'diffString']);
  return {
    path,
    kind: name === 'delete' ? 'delete' : name === 'write' ? 'add' : 'update',
    ...(diff ? { diff } : {}),
  };
}

function toolPayload(toolCall: unknown): { name: string; args: Record<string, unknown>; result: unknown } | undefined {
  const body = asRecord(toolCall);
  if (!body) return undefined;
  const nested = asRecord(body.tool);
  if (nested && typeof nested.case === 'string') {
    const value = asRecord(nested.value);
    return { name: nested.case, args: asRecord(value?.args) ?? {}, result: value?.result };
  }
  const key = Object.keys(body).find((name) => name.endsWith('ToolCall') && name !== 'partialToolCall');
  if (!key) return undefined;
  const value = asRecord(body[key]) ?? {};
  return { name: key, args: asRecord(value.args) ?? {}, result: value.result };
}

function assistantText(event: Record<string, unknown>): string {
  const message = asRecord(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

function todoEntries(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const todo = asRecord(item);
    const content = typeof todo?.content === 'string' ? todo.content : typeof todo?.text === 'string' ? todo.text : '';
    if (!content) return [];
    let status = 'pending';
    if (typeof todo?.status === 'string') status = todo.status;
    else if (todo?.completed === true) status = 'completed';
    return [{ content, status }];
  });
}

function shellOutput(result: unknown): string {
  const root = asRecord(result);
  if (!root) return '';
  const nested = asRecord(root.result);
  const fromCase = nested?.case === 'success' ? asRecord(nested.value)?.stdout : undefined;
  const success = asRecord(root.success);
  const text = typeof fromCase === 'string' ? fromCase : typeof success?.stdout === 'string' ? success.stdout : typeof root.stdout === 'string' ? root.stdout : '';
  return text;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
