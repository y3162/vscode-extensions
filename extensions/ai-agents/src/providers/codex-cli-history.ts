import type { ChatMessage, SessionSummary, TerminalRecord } from '../types.js';
import { extensionVersion } from '../version.js';
import { codexSpawn } from './codex-binary.js';
import { messagesFrom } from './codex-app-server.js';
import type { SessionOptions } from './session-options.js';
import { StdioJsonRpc } from './stdio-rpc.js';

interface HistoryTurn { id: string; prompt?: string }

export interface CodexCliHistory {
  turns(threadId: string): Promise<HistoryTurn[]>;
  forkBeforeTurn(threadId: string, turnId: string, expectedTail?: string[]): Promise<string>;
  terminals(threadId: string): Promise<TerminalRecord[]>;
  listThreads?(): Promise<SessionSummary[]>;
  transcript?(threadId: string): Promise<ChatMessage[]>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createCodexCliHistory(options: SessionOptions): CodexCliHistory {
  const key = options.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  async function opened<T>(work: (rpc: StdioJsonRpc) => Promise<T>): Promise<T> {
    const rpc = new StdioJsonRpc(codexSpawn(options.codexPath, ['app-server', '--listen', 'stdio://'], options.cwd, key));
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'ai_agents_cli_history', title: 'AI Agents', version: extensionVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, AbortSignal.timeout(10000));
      rpc.notify('initialized', {});
      return await work(rpc);
    } finally {
      await rpc.dispose();
    }
  }

  async function connected<T>(threadId: string, work: (rpc: StdioJsonRpc) => Promise<T>): Promise<T> {
    return opened(async (rpc) => {
      const resumed = record(await rpc.request('thread/resume', {
        threadId, cwd: options.cwd, approvalPolicy: 'never', sandbox: options.sandbox || 'workspace-write',
      }, AbortSignal.timeout(10000)));
      if (record(resumed.thread).id !== threadId || record(resumed.thread).historyMode !== 'paginated') {
        throw new Error('Codex CLI の会話はターン境界で安全に分岐できません。');
      }
      return await work(rpc);
    });
  }

  async function list(rpc: StdioJsonRpc, threadId: string): Promise<HistoryTurn[]> {
    const turns: HistoryTurn[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = record(await rpc.request('thread/turns/list', {
        threadId, limit: 50, itemsView: 'full', sortDirection: 'asc', ...(cursor ? { cursor } : {}),
      }, AbortSignal.timeout(10000)));
      if (!Array.isArray(page.data)) throw new Error('Codex CLI のターン履歴を検証できません。');
      for (const value of page.data) {
        const turn = record(value);
        if (typeof turn.id !== 'string' || !turn.id) throw new Error('Codex CLI のターンIDがありません。');
        const user = Array.isArray(turn.items) ? turn.items.map(record).find((item) => item.type === 'userMessage') : undefined;
        const content = user?.content;
        const prompt = Array.isArray(content) ? content.map((item) => record(item).text).filter((text): text is string => typeof text === 'string').join('') : undefined;
        turns.push({ id: turn.id, ...(prompt !== undefined ? { prompt } : {}) });
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codex CLI の履歴カーソルが繰り返されました。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return turns;
  }

  return {
    listThreads: () => opened(async (rpc) => {
      const listed = record(await rpc.request('thread/list', {
        cwd: options.cwd, limit: 30, sortKey: 'updated_at', sortDirection: 'desc',
      }, AbortSignal.timeout(10000)));
      const threads = Array.isArray(listed.data) ? listed.data : Array.isArray(listed.threads) ? listed.threads : [];
      return threads.flatMap((item): SessionSummary[] => {
        const thread = record(record(item).thread ?? item);
        const id = typeof thread.id === 'string' ? thread.id : '';
        if (!id) return [];
        const title = typeof thread.title === 'string' && thread.title ? thread.title : typeof thread.preview === 'string' && thread.preview ? thread.preview : id;
        return [{
          id, title, titleSource: title === id ? 'local' : 'provider', backend: 'cli',
          updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : '',
          provider: 'codex', cwd: options.cwd,
        }];
      });
    }),
    transcript: (threadId) => opened(async (rpc) => {
      const resumed = record(await rpc.request('thread/resume', {
        threadId, cwd: options.cwd, approvalPolicy: 'never', sandbox: options.sandbox || 'workspace-write',
      }, AbortSignal.timeout(10000)));
      if (record(resumed.thread).id !== threadId) throw new Error('Codex CLI の会話を再開できません。');
      if (record(resumed.thread).historyMode === 'paginated') {
        const turns: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = record(await rpc.request('thread/turns/list', {
            threadId, limit: 50, itemsView: 'full', sortDirection: 'asc', ...(cursor ? { cursor } : {}),
          }, AbortSignal.timeout(10000)));
          if (!Array.isArray(page.data)) throw new Error('Codex CLI のターン履歴を検証できません。');
          turns.push(...page.data);
          cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
          if (cursor && cursors.has(cursor)) throw new Error('Codex CLI の履歴カーソルが繰り返されました。');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return messagesFrom({ turns });
      }
      return messagesFrom(await rpc.request('thread/read', { threadId, includeTurns: true }, AbortSignal.timeout(10000)));
    }),
    turns: (threadId) => connected(threadId, (rpc) => list(rpc, threadId)),
    forkBeforeTurn: (threadId, turnId, expectedTail) => connected(threadId, async (rpc) => {
      const source = await list(rpc, threadId);
      if (expectedTail && (source.length < expectedTail.length || expectedTail.some((id, position) => source[source.length - expectedTail.length + position]?.id !== id))) {
        throw new Error('ローカル履歴とCodex CLIの最新ターンが一致しません。');
      }
      const index = source.findIndex((turn) => turn.id === turnId);
      if (index < 0) throw new Error('指定したCodexターンが履歴にありません。');
      const forked = record(await rpc.request('thread/fork', {
        threadId, beforeTurnId: turnId, excludeTurns: true,
      }, AbortSignal.timeout(10000)));
      const branchId = record(forked.thread).id;
      if (typeof branchId !== 'string' || !branchId || branchId === threadId) throw new Error('Codexの分岐を作成できませんでした。');
      const branch = await list(rpc, branchId);
      if (branch.length !== index || branch.some((turn, position) => turn.id !== source[position]?.id)) {
        throw new Error('Codexの分岐が指定ターンの直前で終わっていません。');
      }
      return branchId;
    }),
    terminals: (threadId) => connected(threadId, async (rpc) => {
      const rows: TerminalRecord[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = record(await rpc.request('thread/backgroundTerminals/list', {
          threadId, limit: 20, ...(cursor ? { cursor } : {}),
        }, AbortSignal.timeout(10000)));
        const data = Array.isArray(page.data) ? page.data : page.terminals;
        if (!Array.isArray(data)) throw new Error('Codexのバックグラウンドターミナルを確認できません。');
        for (const value of data) {
          const terminal = record(value);
          const processId = terminal.processId ?? terminal.id;
          if (typeof processId !== 'string' || !processId) throw new Error('CodexのバックグラウンドターミナルIDがありません。');
          rows.push({ processId, status: 'running', ...(typeof terminal.command === 'string' ? { command: terminal.command } : {}) });
        }
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Codexのターミナルカーソルが繰り返されました。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return rows;
    }),
  };
}
