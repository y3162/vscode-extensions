const params = new URLSearchParams(location.search);
const scene = params.get('scene') || 'chat';
const locale = params.get('lang') === 'en' ? 'en' : 'ja';
document.documentElement.lang = locale === 'ja' ? 'ja' : 'en';
if (params.get('theme') === 'light') document.body.classList.add('light', 'vscode-light');
if (params.get('theme') === 'hc') document.body.classList.add('hc', 'vscode-high-contrast');

function shell(extra) {
  const ja = locale === 'ja';
  return {
    conversationId: 'preview', planView: null, timings: [], subagents: [], terminals: [], subagentWaiting: null,
    provider: 'codex', providerLabel: 'Codex · CLI', cwd: '/workspace', busy: false, presence: 'idle',
    statusText: ja ? '準備完了' : 'Ready', sessionTitle: ja ? '認証フローと長いセッションタイトルの表示を確認する' : 'Review authentication flow and long session title',
    modelLabel: 'GPT-6.1 Sol Long Context', effortLabel: 'Extra High', modelSettings: 'new-session', accessLabel: 'Workspace write', risky: false, banner: null,
    backendLabel: 'CLI', folderName: 'vscode-extensions',
    folders: [{ name: 'vscode-extensions', path: '/workspace' }],
    modes: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }, { id: 'ask', label: 'Ask' }], mode: 'agent', showMode: true,
    sandboxChoices: [
      { id: 'read-only', label: 'Read-only' },
      { id: 'workspace-write', label: 'Workspace write' },
      { id: 'danger-full-access', label: 'Full access' },
    ],
    sandbox: 'workspace-write', approvalChoices: [], approval: 'never', showApproval: false,
    webSearchChoices: [], webSearch: '', showWebSearch: false, network: false, showNetwork: true,
    backend: 'cli',
    additionalDirectories: [], autoApprove: false, steer: false, interactiveApproval: false, queue: [],
    changes: [{ path: '/workspace/README.md', name: 'README.md', kind: 'update', additions: 4, deletions: 1, canRevert: true, canDiff: true, synthetic: false }],
    additions: 4, deletions: 1,
    sessions: homeSessions(),
    usage: null, permission: null, plan: null, question: null, activeFile: null, locale,
    providers: [{ id: 'codex', label: 'Codex', detail: 'CLI' }, { id: 'cursor', label: 'Cursor', detail: 'CLI' }],
    sessionId: 'pr',
    ...extra,
    ...(params.get('stress') === '1' ? { modelLabel: 'GPT-6.1 Sol Long Context Research Preview Extended', sessionTitle: ja ? '日本語の長いセッションタイトルと認証処理の実装を確認するための会話' : 'An exceptionally long authentication implementation and review session title' } : {}),
  };
}

function homeSessions() {
  const ja = locale === 'ja';
  const titles = ja
    ? ['プロジェクト概要について', 'PRの修正', 'src/testsのリファクタリング', 'OpenCVライブラリの依存関係']
    : ['Project overview', 'Fix the PR', 'Refactor src/tests', 'OpenCV dependencies'];
  return titles.map((title, index) => ({
    id: ['overview', 'pr', 'tests', 'opencv'][index],
    title,
    updatedAt: new Date(Date.parse('2026-10-28T06:00:00Z') - index * 86400_000).toISOString(),
    provider: 'codex',
    cwd: '/workspace',
  }));
}

const answer = locale === 'ja'
  ? 'README の見出しと手順を直しました。\n\n## 変更点\n\n- インストール手順を一文にまとめた\n- モデル選択の説明を現状に合わせた\n\n```ts\nexport const version = "0.5.0";\n```\n\n詳細は `README.md` を見てください。'
  : 'Updated the README heading and the setup steps.\n\n## Changes\n\n- Collapsed the install steps into one sentence\n- Matched the model-selection description to the current UI\n\n```ts\nexport const version = "0.5.0";\n```\n\nSee `README.md` for the rest.';

function messages(running) {
  const now = Date.parse('2026-10-28T06:00:00Z');
  return [
    { id: 'u', role: 'user', text: locale === 'ja' ? 'READMEの誤字を直して' : 'Fix the typos in the README', at: now - 65_000, attachments: ['README.md'] },
    { id: 't1', role: 'tool', text: 'completed: Read README.md', at: now - 60_000, tool: { kind: 'read', name: 'Read', status: 'completed', target: 'README.md' } },
    { id: 't2', role: 'tool', text: running ? 'in_progress: npm test' : 'completed: npm test\npassed', at: now - 20_000, tool: { kind: 'shell', name: 'command', status: running ? 'running' : 'completed', target: 'npm test' } },
    ...(running ? [] : [{ id: 'a', role: 'assistant', text: answer, at: now - 1_000 }]),
  ];
}

const scenes = {
  'empty-home': () => state(shell({ sessions: [], changes: [], additions: 0, deletions: 0, sessionId: undefined }), []),
  home: () => state(shell({ changes: [], additions: 0, deletions: 0 }), []),
  empty: () => state(shell({ sessions: [], sessionTitle: locale === 'ja' ? '新しいチャット' : 'New chat', changes: [], additions: 0, deletions: 0, sessionId: undefined }), []),
  fresh: () => state(shell({ sessionTitle: locale === 'ja' ? '新しいチャット' : 'New chat', changes: [], additions: 0, deletions: 0, sessionId: undefined }), []),
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
  history: () => state(shell({ changes: [], additions: 0, deletions: 0 }), []),
  composer: () => state(shell({ changes: [], additions: 0, deletions: 0 }), messages(false)),
  settings: () => state(shell({ showApproval: true, approvalChoices: [{ id: 'never', label: 'Never' }, { id: 'on-request', label: 'On request' }], approval: 'on-request', providerLabel: 'Codex · App Server', backend: 'app-server', backendLabel: 'App Server' }), messages(false)),
};

const ja = locale === 'ja';
const planView = { id: 'plan', revision: 2, phase: 'ready', name: ja ? '認証テストの修正' : 'Fix authentication tests', overview: ja ? '失敗を再現し、修正後に関連テストを確認します。' : 'Reproduce the failure, fix it, and verify related tests.', markdown: '## Authentication\n\n1. Reproduce the failure\n2. Fix the tests\n3. Verify results', todos: [{ content: ja ? '失敗を再現する' : 'Reproduce the failure', status: 'completed' }, { content: ja ? '認証テストを修正する' : 'Fix authentication tests', status: 'pending' }], files: ['src/auth.test.ts'], source: 'native', buildModelId: 'gpt-sol', buildModelLabel: 'GPT-6.1 Sol Long Context · Extra High', buildParams: [], showBuildModel: true, canBuild: true, history: [] };
const planningMessages = [{ id: 'u-plan', role: 'user', text: ja ? '認証テストを修正する計画を作って' : 'Plan the authentication test fix', at: 1793167200000 }, { id: 'a-plan', role: 'assistant', text: ja ? '修正の計画をまとめました。内容を確認してから Build を開始できます。' : 'The plan is ready. Review it before starting the build.', at: 1793167260000, final: true }];
const child = { id: 'child', name: ja ? '認証フローのレビュー' : 'Authentication review', task: ja ? '認証コードとテストの整合性を確認する' : 'Check authentication code and test consistency', status: 'running', background: true, startedAt: 1793167200000, progress: ja ? '関連テストを確認中' : 'Reviewing related tests', model: 'GPT-6.1 Sol' };
const usage = { inputTokens: 18000, outputTokens: 2600, totalTokens: 20600, cachedInputTokens: 12000, contextTokens: 20600, contextWindow: 128000 };
Object.assign(scenes, {
  plan: () => state(shell({ mode: 'plan', planView }), planningMessages),
  'plan-expanded': () => state(shell({ mode: 'plan', planView }), planningMessages),
  build: () => state(shell({ mode: 'agent', busy: true, presence: 'running', statusText: ja ? 'Build 実行中' : 'Building', planView: { ...planView, phase: 'building', canBuild: false } }), messages(true)),
  error: () => state(shell({ presence: 'error', statusText: ja ? '実行に失敗しました' : 'Run failed' }), [...messages(true), { id: 'e', role: 'error', text: ja ? 'テストの実行に失敗しました。作業フォルダーと依存関係を確認してください。' : 'Tests could not run. Check the workspace and dependencies.', at: 1793167260000 }]),
  subagent: () => state(shell({ busy: true, presence: 'running', subagents: [child, { ...child, id: 'done', name: 'Review tests', status: 'completed', durationMs: 8000 }], subagentWaiting: { startedAt: 1793167200000, count: 2 } }), messages(true)),
  'subagent-detail': () => state(shell({ busy: true, presence: 'running', subagents: [child] }), messages(true)),
  terminal: () => state(shell({ busy: true, presence: 'running', terminals: [{ processId: 'p1', command: 'npm run watch -- --project extensions/ai-agents/tsconfig.webview.json', status: 'running', output: 'Watching for changes…\nBuild completed successfully.' }] }), messages(true)),
  model: () => state(shell({ changes: [] }), messages(false)),
  'model-list': () => state(shell({ changes: [] }), messages(false)),
  mode: () => state(shell({ changes: [] }), messages(false)),
  question: () => state(shell({ busy: true, presence: 'waiting', statusText: ja ? '回答待ち' : 'Waiting for answers', question: { token: 'q-token', request: { id: 'q1', title: ja ? '実装方針を確認' : 'Confirm implementation', questions: [{ id: 'q', prompt: ja ? 'どのテストを優先しますか？' : 'Which tests should run first?', options: [{ id: 'unit', label: ja ? '単体テスト' : 'Unit tests' }, { id: 'integration', label: ja ? '統合テスト' : 'Integration tests' }], allowMultiple: false }, { id: 'note', prompt: ja ? '補足事項' : 'Additional context', options: [] }] } } }), messages(true)),
  usage: () => state(shell({ usage, timings: [{ id: 'u', startedAt: 1793167200000, endedAt: 1793167260000, waitMs: 0, status: 'completed', intent: 'agent', usage }] }), messages(false)),
  queue: () => state(shell({ busy: true, presence: 'running', steer: true, queue: [{ id: 'queued', text: ja ? '続いて関連するドキュメントも確認してください' : 'Next, review the related documentation', images: 0 }] }), messages(true)),
  changes: () => state(shell({ changes: Array.from({ length: 8 }, (_, i) => ({ path: `/workspace/src/long/path/authentication-${i}.test.ts`, name: `authentication-${i}.test.ts`, kind: 'update', additions: 12, deletions: 3, canDiff: true, canRevert: i !== 0, synthetic: false })), additions: 96, deletions: 24 }), messages(false)),
  activity: () => state(shell(), [
    { id: 'u', role: 'user', text: ja ? 'READMEを整えて' : 'Refine the README', attachments: ['README.md', 'extensions/ai-agents/package.json'], at: 1793167200000 },
    { id: 'think', role: 'status', text: ja ? 'READMEと関連する構成を確認します。' : 'I will check the README and the related layout.', at: 1793167210000, meta: { type: 'thinking' } },
    { id: 'read1', role: 'tool', text: 'read', at: 1793167220000, tool: { kind: 'read', name: 'Read', status: 'completed', target: 'README.md', line: 1, endLine: 40 } },
    { id: 'read2', role: 'tool', text: 'read', at: 1793167230000, tool: { kind: 'read', name: 'Read', status: 'completed', target: 'extensions/ai-agents/README.md', line: 1, endLine: 20 } },
    { id: 'search', role: 'tool', text: 'found', at: 1793167240000, tool: { kind: 'search', name: 'Search', status: 'completed', target: 'test:runtime' } },
    { id: 'shell', role: 'tool', text: 'completed: npm test\npassed\n', at: 1793167250000, tool: { kind: 'shell', name: 'command', status: 'completed', target: 'npm test' } },
    { id: 'files', role: 'tool', text: 'changed', at: 1793167255000, meta: { type: 'files', files: [{ path: 'README.md', kind: 'update', additions: 6, deletions: 2 }] } },
    { id: 'a', role: 'assistant', text: answer, at: 1793167260000, final: true },
  ]),
});

function state(current, items) {
  return { type: 'state', revision: 1, full: true, shell: current, messages: { removed: [], upserts: items, order: items.map((item) => item.id) } };
}

const chatScenes = new Set(Object.keys(scenes).filter((key) => !['home', 'history', 'empty-home'].includes(key)));
window.previewPosts = [];
window.previewState = null;
window.previewSetState = (next) => { window.previewState = next; window.dispatchEvent(new MessageEvent('message', { data: next })); };
window.previewReady = false;
const frameWidth = Number(params.get('width') || 0);
const frameHeight = Number(params.get('height') || 0);
const frame = document.getElementById('app');
if (frame && frameWidth) {
  frame.style.width = `${frameWidth}px`;
  frame.style.height = `${frameHeight || window.innerHeight}px`;
  frame.style.overflow = 'hidden';
}

window.acquireVsCodeApi = () => ({
  postMessage(message) {
    window.previewPosts.push(message);
    if (message.type === 'loadModelCatalog') {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'modelCatalog', requestId: message.requestId, provider: 'codex', cwd: '/workspace', status: 'ready',
          selectedModelId: 'gpt-sol', selectedParams: [{ id: 'modelReasoningEffort', value: 'xhigh' }],
          models: [
            { id: 'gpt-sol', label: params.get('stress') === '1' ? 'GPT-6.1 Sol Long Context Research Preview Extended' : 'GPT-6.1 Sol Long Context', parameters: [
              { id: 'fast', label: 'Fast', role: 'fast', presentation: 'toggle', values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] },
              { id: 'context', label: 'Context', role: 'context', presentation: 'menu', values: [{ value: '256k', label: '256K' }, { value: '500k', label: '500K' }] },
              { id: 'modelReasoningEffort', label: 'Effort', role: 'effort', presentation: 'menu', defaultValue: 'high', values: [
                { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra High' },
              ] },
            ] },
            { id: 'composer', label: 'Composer 2.5', parameters: [] },
          ],
        },
      }));
      return;
    }
    if (message.type !== 'ready') return;
    window.previewSetState(scenes[scene]?.() || scenes.home());
    requestAnimationFrame(() => {
      if (scene === 'model' || scene === 'model-list') document.querySelector('.model-name')?.click();
      if (scene === 'model-list') document.querySelector('.model-menu [data-id="model"]')?.click();
      if (scene === 'mode') document.querySelector('.mode')?.click();
      if (scene === 'usage') document.querySelector('.usage-panel').open = true;
      if (scene === 'changes') document.querySelector('.change-toggle')?.click();
      if (scene === 'plan-expanded') document.querySelector('.plan-view-toggle')?.click();
      if (scene === 'subagent-detail') document.querySelector('.subagent-panel-open')?.click();
      if (scene === 'activity') {
        document.querySelector('.log-toggle')?.click();
        document.querySelector('.explore-toggle')?.click();
      }
      window.previewReady = true;
    });
    if (scene === 'settings') {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', panel: 'settings' } }));
    }
  },
  getState() {
    if (scene === 'composer') return { page: 'chat', draft: locale === 'ja' ? 'このPRのテストを直して' : 'Fix the tests on this PR' };
    if (chatScenes.has(scene)) return { page: 'chat' };
    return null;
  },
  setState() {},
});
