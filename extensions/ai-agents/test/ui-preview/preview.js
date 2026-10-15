const params = new URLSearchParams(location.search);
const scene = params.get('scene') || 'chat';
const locale = params.get('lang') === 'en' ? 'en' : 'ja';
document.documentElement.lang = locale === 'ja' ? 'ja' : 'en';
if (params.get('theme') === 'light') document.body.classList.add('light');
if (params.get('theme') === 'hc') document.body.classList.add('hc', 'vscode-high-contrast');

function shell(extra) {
  const ja = locale === 'ja';
  return {
    provider: 'codex', providerLabel: 'Codex · SDK', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: ja ? '準備完了' : 'Ready', sessionTitle: ja ? 'READMEの誤字を直す' : 'Fix the README',
    modelLabel: 'gpt-5', effortLabel: 'high', accessLabel: 'Workspace write', risky: false, banner: null,
    backendLabel: 'SDK', folderName: 'vscode-extensions',
    folders: [{ name: 'vscode-extensions', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }], mode: 'agent', showMode: true,
    sandboxChoices: [
      { id: 'read-only', label: 'Read-only' },
      { id: 'workspace-write', label: 'Workspace write' },
      { id: 'danger-full-access', label: 'Full access' },
    ],
    sandbox: 'workspace-write', approvalChoices: [], approval: 'never', showApproval: false,
    webSearchChoices: [], webSearch: '', showWebSearch: false, network: false, showNetwork: true,
    backendChoices: [{ id: 'sdk', label: 'SDK' }, { id: 'app-server', label: 'App Server' }], backend: 'sdk',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [],
    changes: [{ path: '/workspace/README.md', name: 'README.md', kind: 'update', additions: 4, deletions: 1, canRevert: true, canDiff: true, synthetic: false }],
    additions: 4, deletions: 1,
    sessions: [
      { id: 'a', title: ja ? 'READMEの誤字を直す' : 'Fix the README', updatedAt: new Date(Date.now() - 3600_000).toISOString(), provider: 'codex', cwd: '/workspace' },
      { id: 'b', title: ja ? '拡張機能の構成を設計' : 'Design the extension', updatedAt: new Date(Date.now() - 86400_000 * 3).toISOString(), provider: 'codex', cwd: '/workspace' },
      { id: 'c', title: ja ? '容量不足の整理候補を探す' : 'Find disk usage', updatedAt: new Date(Date.now() - 86400_000 * 5).toISOString(), provider: 'codex', cwd: '/workspace' },
    ],
    usage: null, permission: null, plan: null, question: null, activeFile: null, locale,
    providers: [{ id: 'codex', label: 'Codex', detail: 'SDK' }, { id: 'cursor', label: 'Cursor', detail: 'SDK' }],
    ...extra,
  };
}

const answer = locale === 'ja'
  ? 'README の見出しと手順を直しました。\n\n## 変更点\n\n- インストール手順を一文にまとめた\n- モデル選択の説明を現状に合わせた\n\n```ts\nexport const version = "0.5.0";\n```\n\n詳細は `README.md` を見てください。'
  : 'Updated the README heading and the setup steps.\n\n## Changes\n\n- Collapsed the install steps into one sentence\n- Matched the model-selection description to the current UI\n\n```ts\nexport const version = "0.5.0";\n```\n\nSee `README.md` for the rest.';

function messages(running) {
  const now = Date.now();
  return [
    { id: 'u', role: 'user', text: locale === 'ja' ? 'READMEの誤字を直して' : 'Fix the typos in the README', at: now - 65_000, attachments: ['README.md'] },
    { id: 't1', role: 'tool', text: 'completed: Read README.md', at: now - 60_000, tool: { kind: 'read', name: 'Read', status: 'completed', target: 'README.md' } },
    { id: 't2', role: 'tool', text: running ? 'in_progress: npm test' : 'completed: npm test\npassed', at: now - 20_000, tool: { kind: 'shell', name: 'command', status: running ? 'running' : 'completed', target: 'npm test' } },
    ...(running ? [] : [{ id: 'a', role: 'assistant', text: answer, at: now - 1_000 }]),
  ];
}

const scenes = {
  empty: () => ({ type: 'state', revision: 1, full: true, shell: shell({ sessionTitle: locale === 'ja' ? '新しいチャット' : 'New chat', changes: [], additions: 0, deletions: 0 }), messages: { removed: [], upserts: [], order: [] } }),
  chat: () => state(shell(), messages(false)),
  running: () => state(shell({ busy: true, presence: 'running', statusText: locale === 'ja' ? '実行中…' : 'Running…' }), messages(true)),
  approval: () => state(shell({
    presence: 'waiting', statusText: locale === 'ja' ? '承認待ち' : 'Waiting for approval', busy: true,
    permission: { token: 'tok', request: { id: 'perm', title: locale === 'ja' ? 'コマンドを実行' : 'Run command', detail: 'npm test', kind: 'shell' } },
  }), messages(true)),
  banner: () => state(shell({
    accessLabel: 'Full access', risky: true, sandbox: 'danger-full-access',
    banner: { id: 'banner', title: locale === 'ja' ? 'フルアクセスがオンです' : 'Full access is on', body: locale === 'ja' ? 'サンドボックスが無効です。確認なしにファイルの変更やコマンドの実行が許可されることがあります。' : 'The sandbox is off. File changes and commands may run without a prompt.' },
  }), messages(false)),
  history: () => state(shell(), messages(false)),
  settings: () => state(shell({ showApproval: true, approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }], approval: 'on-request', providerLabel: 'Codex · App Server', backend: 'app-server', backendLabel: 'App Server' }), messages(false)),
};

function state(current, items) {
  return { type: 'state', revision: 1, full: true, shell: current, messages: { removed: [], upserts: items, order: items.map((item) => item.id) } };
}

window.acquireVsCodeApi = () => ({
  postMessage(message) {
    if (message.type !== 'ready') return;
    window.dispatchEvent(new MessageEvent('message', { data: scenes[scene]?.() || scenes.chat() }));
    if (scene === 'history' || scene === 'settings') {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', panel: scene } }));
    }
  },
  getState() { return null; },
  setState() {},
});
