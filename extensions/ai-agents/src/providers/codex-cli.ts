import type { ThreadItem } from '@openai/codex-sdk';
import { captureGitBaselines } from '../change-tracker.js';
import { writeImageFiles } from '../images.js';
import type { AgentSession, AgentUpdate } from '../types.js';
import { codexLaunch } from './codex-binary.js';
import { createCodexCliHistory, type CodexCliHistory } from './codex-cli-history.js';
import { readJsonEvents, spawnCli, type CliSpawn } from './cli-jsonl.js';
import { codexMeta, codexUsage } from './details.js';
import { codexUpdate } from './events.js';
import type { SessionOptions } from './session-options.js';
import { codexTool } from './tools.js';

const approvalError = 'この承認ポリシーは対話操作が必要です。バックエンドを Codex App Server に切り替えてください。';

export function codexCliArgs(options: {
  cwd: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  network?: boolean;
  webSearch?: string;
  additionalDirectories?: string[];
  resumeId?: string;
  images?: string[];
}): string[] {
  const sandbox = options.sandbox === 'read-only' || options.sandbox === 'danger-full-access' ? options.sandbox : 'workspace-write';
  return [
    'exec', '--json', '--skip-git-repo-check',
    '-s', sandbox,
    '-C', options.cwd,
    ...(options.model ? ['-m', options.model] : []),
    ...(options.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []),
    ...(options.webSearch ? ['-c', `web_search="${options.webSearch}"`] : []),
    ...(options.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(options.additionalDirectories ?? []).flatMap((directory) => ['--add-dir', directory]),
    ...(options.images ?? []).flatMap((image) => ['-i', image]),
    ...(options.resumeId ? ['resume', options.resumeId] : []),
  ];
}

export async function createCodexCliSession(options: SessionOptions, dependencies: {
  spawn?: CliSpawn;
  writeImages?: typeof writeImageFiles;
  history?: CodexCliHistory;
} = {}): Promise<AgentSession> {
  if (options.approval && options.approval !== 'never') throw new Error(approvalError);
  const spawn = dependencies.spawn ?? spawnCli;
  const writeImages = dependencies.writeImages ?? writeImageFiles;
  // Test spawns do not own real Codex threads. Production sessions use the local
  // App Server only for verified history metadata; prompts still run through CLI.
  const history = dependencies.history ?? (dependencies.spawn ? undefined : createCodexCliHistory(options));
  let sessionId = options.resumeId;
  let backendTurnId: string | undefined;
  let verifiedTail: string[] | undefined;
  let rewindReason = history ? '' : 'Codex CLI のターン履歴を確認できません。';
  let model = options.model;
  let effort = options.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value;
  let active: { kill(): void } | undefined;
  if (history && sessionId) {
    try { await history.turns(sessionId); rewindReason = ''; }
    catch (error) { rewindReason = error instanceof Error ? error.message : String(error); }
  }
  const identify = (title: string) => {
    if (!sessionId) return;
    options.onIdentity?.({
      id: sessionId, title, titleSource: 'local', updatedAt: new Date().toISOString(), provider: 'codex', cwd: options.cwd,
    });
  };
  return {
    get sessionId() { return sessionId; },
    ...(history ? {
      rewindUnsupportedReason: () => rewindReason || undefined,
      latestBackendTurnId: () => backendTurnId,
      verifyTurnHistory: async (ids: string[]) => {
        if (!sessionId || !ids.length) throw new Error('照合できるCodex CLIターンがありません。');
        const turns = await history.turns(sessionId);
        if (turns.length < ids.length || ids.some((id, index) => turns[turns.length - ids.length + index]?.id !== id)) {
          throw new Error('ローカル履歴とCodex CLIの最新ターンが一致しません。');
        }
        verifiedTail = [...ids];
      },
      forkBeforeTurn: async (turnId: string) => {
        if (!sessionId || rewindReason) throw new Error(rewindReason || 'Codex CLI の会話IDがありません。');
        if (!verifiedTail?.includes(turnId)) throw new Error('Codex CLIのターン履歴が検証されていません。');
        return history.forkBeforeTurn(sessionId, turnId, verifiedTail);
      },
      listBackgroundTerminals: async () => {
        if (!sessionId) throw new Error('Codex CLI の会話IDがありません。');
        return history.terminals(sessionId);
      },
    } : {}),
    setModel(selection) {
      model = selection.model;
      effort = selection.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value;
    },
    async run(prompt, signal, emit, extras, turn) {
      backendTurnId = undefined;
      verifiedTail = undefined;
      let previousTurns: Awaited<ReturnType<CodexCliHistory['turns']>> = [];
      if (history && sessionId) {
        try { previousTurns = await history.turns(sessionId); rewindReason = ''; }
        catch (error) { rewindReason = error instanceof Error ? error.message : String(error); }
      }
      const baselines = history ? await captureGitBaselines(options.cwd) : undefined;
      const selection = turn?.selection;
      const turnModel = selection?.model ?? model;
      const turnEffort = selection?.modelParams?.find((param) => param.id === 'modelReasoningEffort')?.value ?? effort;
      const images = await writeImages(extras?.images ?? []);
      const args = codexCliArgs({
        cwd: options.cwd,
        model: turnModel || undefined,
        effort: turnEffort,
        sandbox: options.sandbox,
        network: options.network,
        webSearch: options.webSearch,
        additionalDirectories: options.additionalDirectories,
        resumeId: sessionId,
        images,
      });
      const key = options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
      const launch = codexLaunch(options.codexPath, args, options.cwd, key);
      const run = spawn({ command: launch.command, args: launch.args, cwd: options.cwd, env: launch.env, input: prompt });
      active = run;
      try {
        await readJsonEvents(run, signal, (event) => {
          const record = asRecord(event);
          if (!record || typeof record.type !== 'string') return;
          if (record.type === 'thread.started' && typeof record.thread_id === 'string' && record.thread_id) {
            sessionId = record.thread_id;
            identify(prompt.slice(0, 80) || 'Codex');
            return;
          }
          if (record.type === 'turn.failed') {
            const error = asRecord(record.error);
            throw new Error(typeof error?.message === 'string' && error.message ? error.message : 'Codex CLI の実行に失敗しました。');
          }
          if (record.type === 'error') {
            throw new Error(typeof record.message === 'string' && record.message ? record.message : 'Codex CLI の実行に失敗しました。');
          }
          if (record.type === 'turn.completed') {
            const usage = cliUsage(record.usage);
            if (usage && !signal.aborted) {
              emit({ id: 'usage-turn.completed', role: 'status', text: '', meta: { type: 'usage', usage: {
                ...usage, scope: 'session', source: 'codex-cli', inputIncludesCache: true,
              } } });
            }
            return;
          }
          if (record.type !== 'item.started' && record.type !== 'item.updated' && record.type !== 'item.completed') return;
          const item = threadItem(record.item);
          if (!item || signal.aborted) return;
          const update = codexUpdate(item);
          const meta = codexMeta(item);
          const tool = codexTool(item);
          if (update) emit({ ...update, ...(meta ? { meta } : {}), ...(tool ? { tool } : {}) });
        });
        if (history && sessionId && !signal.aborted && !rewindReason) {
          try {
            const turns = await history.turns(sessionId);
            const last = turns.at(-1);
            if (turns.length !== previousTurns.length + 1 || previousTurns.some((item, index) => item.id !== turns[index]?.id)
              || !last || last.prompt !== prompt) {
              throw new Error('Codex CLI の実行とターン履歴を一意に対応付けられません。');
            }
            backendTurnId = last.id;
            const changes = await baselines?.changes();
            if (changes) emit({ id: `workspace-changes:${last.id}`, backendTurnId: last.id, role: 'tool', text: 'diff updated', meta: { type: 'files', files: changes } });
          } catch (error) {
            rewindReason = error instanceof Error ? error.message : String(error);
          }
        }
        identify(prompt.slice(0, 80) || 'Codex');
      } finally {
        if (active === run) active = undefined;
      }
    },
    async dispose() { active?.kill(); },
  };
}

function cliUsage(value: unknown): ReturnType<typeof codexUsage> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const numeric = (key: string) => typeof usage[key] === 'number' ? usage[key] as number : undefined;
  const input = numeric('input_tokens');
  const output = numeric('output_tokens');
  const cached = numeric('cached_input_tokens');
  const reasoning = numeric('reasoning_output_tokens');
  if (input === undefined || output === undefined || cached === undefined || reasoning === undefined) return undefined;
  return codexUsage({
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_write_input_tokens: numeric('cache_write_input_tokens') ?? 0,
    reasoning_output_tokens: reasoning,
  });
}

function threadItem(value: unknown): ThreadItem | undefined {
  const item = asRecord(value);
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return undefined;
  if (!acceptedThreadItem(item)) return undefined;
  return item as unknown as ThreadItem;
}

function acceptedThreadItem(item: Record<string, unknown>): boolean {
  switch (item.type) {
    case 'agent_message':
    case 'reasoning':
      return typeof item.text === 'string';
    case 'error':
      return typeof item.message === 'string';
    case 'command_execution':
      return typeof item.command === 'string' && typeof item.aggregated_output === 'string' && typeof item.status === 'string';
    case 'file_change':
      return typeof item.status === 'string' && Array.isArray(item.changes) && item.changes.every((change) => {
        const file = asRecord(change);
        return typeof file?.path === 'string' && typeof file.kind === 'string';
      });
    case 'mcp_tool_call':
      return typeof item.server === 'string' && typeof item.tool === 'string' && typeof item.status === 'string';
    case 'web_search':
      return typeof item.query === 'string';
    case 'todo_list':
      return Array.isArray(item.items) && item.items.every((todo) => {
        const entry = asRecord(todo);
        return typeof entry?.text === 'string' && typeof entry.completed === 'boolean';
      });
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
