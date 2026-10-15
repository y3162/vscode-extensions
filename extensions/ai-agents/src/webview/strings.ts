import type { ToolInfo } from '../types.js';

export type Locale = 'ja' | 'en';

const copy = {
  ja: {
    placeholder: '何でも依頼できます。@ でファイル、/ でコマンド',
    send: '送信',
    queue: 'キューに追加',
    stop: '停止',
    newChat: '新しいチャット',
    history: '履歴',
    viewAll: 'すべて表示',
    noSessions: '履歴はありません',
    emptyTitle: 'AI Agents',
    emptyHint: '@ でファイル、/ でコマンドを参照できます。',
    allow: '許可',
    allowSession: 'このセッションでは許可',
    deny: '拒否',
    approve: '承認',
    reject: '却下',
    answer: '回答',
    submit: '送信',
    worked: '作業しました',
    working: '作業中…',
    thought: '思考',
    copy: 'コピー',
    copied: 'コピーしました',
    retry: '再試行',
    logs: 'ログ',
    diagnose: '診断',
    changes: '変更',
    revert: '戻す',
    open: '開く',
    diff: '差分',
    latest: '最新へ',
    attach: '添付',
    image: '画像',
    file: 'ファイル',
    selection: '選択範囲',
    problems: '問題',
    git: 'Git 差分',
    terminal: 'ターミナル',
    dismiss: '閉じる',
    dontShow: '今後表示しない',
    settings: '詳細設定',
    close: '閉じる',
    sandboxNote: 'サンドボックス、承認、バックエンドを変えると新しい会話になります。',
    mode: 'モード',
    model: 'モデル',
    modelDetails: 'モデルの詳細',
    access: '権限',
    folder: 'フォルダ',
    local: 'Local',
    backend: 'バックエンド',
    autoApprove: '自動承認',
    network: 'ネットワークを明示的に許可',
    webSearch: '検索',
    directories: '追加ディレクトリ',
    remove: '削除',
    usage: '使用量',
    rules: 'ルール / Skills / MCP',
    signIn: 'ログイン',
    apiKey: 'APIキー',
    vscodeSettings: 'VS Code の設定',
    showMore: '続きを表示',
    showLess: '折りたたむ',
    sendNow: '今すぐ送る',
    steer: '実行中に追加',
    plan: '計画',
    question: '質問',
    patch: 'パッチ',
    provider: 'エージェント',
    switchNote: 'エージェントを切り替えると新しい会話になります。',
    environment: '作業環境',
  },
  en: {
    placeholder: 'Ask anything. @ for files, / for commands',
    send: 'Send',
    queue: 'Queue',
    stop: 'Stop',
    newChat: 'New chat',
    history: 'History',
    viewAll: 'View all',
    noSessions: 'No history yet',
    emptyTitle: 'AI Agents',
    emptyHint: 'Use @ for files and / for commands.',
    allow: 'Allow',
    allowSession: 'Allow for session',
    deny: 'Deny',
    approve: 'Approve',
    reject: 'Reject',
    answer: 'Answer',
    submit: 'Submit',
    worked: 'Worked',
    working: 'Working…',
    thought: 'Thought',
    copy: 'Copy',
    copied: 'Copied',
    retry: 'Retry',
    logs: 'Logs',
    diagnose: 'Diagnose',
    changes: 'Changes',
    revert: 'Revert',
    open: 'Open',
    diff: 'Diff',
    latest: 'Latest',
    attach: 'Attach',
    image: 'Image',
    file: 'File',
    selection: 'Selection',
    problems: 'Problems',
    git: 'Git diff',
    terminal: 'Terminal',
    dismiss: 'Dismiss',
    dontShow: "Don't show again",
    settings: 'Settings',
    close: 'Close',
    sandboxNote: 'Changing the sandbox, approval, or backend starts a new chat.',
    mode: 'Mode',
    model: 'Model',
    modelDetails: 'Model details',
    access: 'Access',
    folder: 'Folder',
    local: 'Local',
    backend: 'Backend',
    autoApprove: 'Auto-approve',
    network: 'Explicitly allow network',
    webSearch: 'Search',
    directories: 'Additional directories',
    remove: 'Remove',
    usage: 'Usage',
    rules: 'Rules / Skills / MCP',
    signIn: 'Sign in',
    apiKey: 'API key',
    vscodeSettings: 'VS Code settings',
    showMore: 'Show more',
    showLess: 'Show less',
    sendNow: 'Send now',
    steer: 'Steer',
    plan: 'Plan',
    question: 'Question',
    patch: 'Patch',
    provider: 'Agent',
    switchNote: 'Switching agents starts a new chat.',
    environment: 'Environment',
  },
} as const;

export type Copy = { [K in keyof typeof copy.en]: string };

export function strings(locale: Locale): Copy {
  return copy[locale];
}

export function countLabel(locale: Locale, kind: ToolInfo['kind'], count: number): string {
  const labels: Record<ToolInfo['kind'], [string, string]> = {
    read: [`${count}ファイルを読み込み`, count === 1 ? 'Read 1 file' : `Read ${count} files`],
    edit: [`${count}ファイルを編集`, count === 1 ? 'Edited 1 file' : `Edited ${count} files`],
    search: [`${count}件を検索`, count === 1 ? 'Searched once' : `Searched ${count} times`],
    shell: [`${count}件のコマンドを実行`, count === 1 ? 'Ran 1 command' : `Ran ${count} commands`],
    git: [`Git を ${count}回`, count === 1 ? 'Ran 1 git command' : `Ran ${count} git commands`],
    mcp: [`MCP を ${count}回`, count === 1 ? 'Called 1 MCP tool' : `Called ${count} MCP tools`],
    subagent: [`サブエージェント ${count}`, count === 1 ? '1 subagent' : `${count} subagents`],
    other: [`${count}件のツール`, count === 1 ? '1 tool' : `${count} tools`],
  };
  return labels[kind][locale === 'ja' ? 0 : 1];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${rest}s`;
}

export function relativeTime(locale: Locale, value: string, now = Date.now()): string {
  const then = Date.parse(value);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return locale === 'ja' ? 'たった今' : 'just now';
  if (minutes < 60) return locale === 'ja' ? `${minutes}分前` : `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === 'ja' ? `${hours}時間前` : `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return locale === 'ja' ? `${days}日前` : `${days}d`;
  return new Date(then).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', { month: 'short', day: 'numeric' });
}
