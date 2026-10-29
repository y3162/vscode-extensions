# Cursor UI リバースエンジニアリング（2026-10-28）

対象リポジトリの HEAD は `f146f8fe7ab0231971a345764c5bad4cf2ef4419`（`main`）。以前の `dcf98ff` より新しい。本番 Webview と CLI は変更していない。

証拠レベル:

| 記号 | 意味 |
| --- | --- |
| A | 隔離した Cursor 3.26.13 の DOM / computed style |
| B | インストール済み `Cursor.app` の CSS / JavaScript |
| C | 公開リポジトリの解析。現行 Cursor では未確認、または古い |
| D | このリポジトリ内の AI Agents スクリーンショット |
| E | サイドバー Webview 向けの変換判断 |

## 調査環境

- Cursor 3.26.13（commit `3bfec373749d3d4a53a151283022d49743ab50b0`、quality stable、2026-10-20）
- VS Code ベース 1.128.0
- Electron 42.10.0
- Chrome 148.0.7778.280
- V8 14.8.178.38
- バンドル: `Contents/Resources/app/out/vs/workbench/workbench.desktop.main.css`（1.2MB）、`workbench.desktop.main.js`（39MB）、`workbench.glass.main.js`（47MB）
- 読み込み: `out/vs/code/electron-sandbox/workbench/workbench.html` が desktop CSS と `workbench.js` を読む。Agents Window は glass バンドルを使う
- 通常の Cursor プロセスは残した。計測用は空の `--user-data-dir /tmp/cursor-ui-probe-20261028` と別 extensions-dir、デバッグポート `127.0.0.1:9333`。計測後にそのプロセスだけ終了した
- 開いた画面はタイトル `Cursor Agents`、`data-cursor-glass-mode=true`、Dark。チャット本文は無い
- サイドバーに表示名が出たのでスクリーンショットは保存していない。数値だけ `docs/cursor-ui-analysis/` に置いた

再計測するときは、同じフラグで隔離プロセスを起動し、CDP の page ターゲットに対して `Runtime.evaluate` する。認証を足さない。通常の user-data-dir は使わない。終了後にポートが閉じていることを確認する。

## セレクタの新旧

CursorRemote が使っていたセレクタを、3.26.13 の desktop CSS で数えた。

| セレクタ | CSS 出現 | 扱い |
| --- | --- | --- |
| `composer-rendered-message` | 0 | 現行の確定セレクタにしない（C） |
| `ui-thinking-collapsible` | 0。JS の rootClass が 1 | 思考 UI のクラス名としては残る（B） |
| `composer-tool-former-message` | 0 | 古い（C） |
| `composer-create-plan-container` | 0 | 計画は `composer-plan-container`（B） |
| `composer-terminal-tool-call-block-container` | 0 | 古い（C） |
| `composer-edit-file-review-wrapper` | 0 | 古い（C） |
| `data-flat-index` | JS 0 | 現行 DOM の契約にしない（C） |
| `composer-human-message` | CSS あり、JS 14 | ユーザーメッセージ（B） |
| `aislash-editor-input` / `-readonly` | CSS あり | 入力と読み取り専用本文（B） |
| `markdown-root` | CSS あり | 回答本文（B） |
| `ui-tool-call-line` | JS | ツール行（B） |
| `composer-unified-dropdown` | CSS 23 | モード（B） |
| `ui-prompt-input` | 実行 DOM | Agents の Composer（A） |

CursorRemote の電話 UI（`.human-bubble` など）は Cursor の CSS ではない。採用しない。

## 実測した Agents Window

空状態で、サイドバーを隠したあとの CSS ビューポート。

| ビューポート | プロンプト枠 | 入力 | ツールバー |
| --- | --- | --- | --- |
| 300 | x=40, 220×106 | 218×64 | 218×40 |
| 390 | x=40, 310×106 | 308×64 | 308×40 |
| 600 | x=40, 520×106 | 518×64 | 518×40 |
| 1000 | x=196, 608×106 | 606×64 | 606×40 |
| 1280 | x=336, 608×106 | 606×64 | 606×40 |

幅の規則（A）: `min(608px, viewport - 80px)`。左右 40px で、608px に達すると中央に寄る。608px は、最大 640px の列から左右 16px を引いた値と一致する（B の `max-width: min(100%, 640px)` と padding `8px 16px 32px`）。

プロンプト枠（A）:

- 背景 `color(srgb 0.130 0.130 0.130)`
- 枠 `1px solid`、前景色の 8%
- 角丸 20px
- ルートは column、gap 12px
- ツールバーは height 40px、padding 8px、gap 8px、space-between
- 左グループの gap は 4px、ボタン高さ 24px
- モデルは高さ 24px、角丸 9999px、padding `0 6px 0 8px`
- パネル背景は前景に近い色の 72% アルファ。`--vscode-editor-background` と `--vscode-input-background` はどちらも `#181818`
- `--cursor-radius-xl` は 12px。`--cursor-font-size-base` は 13px、lg は 14px。line-height lg は 22px

空の Composer に見えた操作（A）: 「Add agents, context, tools」、モデル名、音声入力、音声チャット。Agent / Plan のモードボタンはこの空状態には無かった。

この画面はホームの中央配置である。会話が溜まったあとの Composer が下に固定されるかは見ていない。

## バンドルから確定した会話構造

ユーザーメッセージ（B、desktop CSS）:

- `.composer-human-message:not(.standalone-glass)` は `width: 100%`、`min-width: 150px`、`align-self: flex-end`
- 幅が 100% なので、親列の中では左端から右端まで埋まる。右寄せの短い吹き出しではない
- 背景 `var(--vscode-input-background)`、枠 `1px solid var(--cursor-stroke-secondary)`、角丸は `--cursor-radius-xl`（12px）
- 本文 padding は 8px 10px、gap 6px、font-size 14px、line-height 22px
- hover で枠が `--cursor-stroke-primary`（前景 20%）になる
- 別レイアウト `data-project-send-message-layout` は `width: fit-content`、最大 `min(480px, 100%)`、左に `max(32px, clamp(0px, (100% - 480px) * 0.4, 20%))` を空けて右へ寄せる。サイドバー仕様には採用しない

作業時間（B、`turn-work-timing.js`）:

- `Worked for ${format(ms)}`
- 1 秒未満は `1s`。60 秒未満は切り上げ秒。60 分未満は `Nm Ns`。それ以上は `Nh Nm`
- 0 以下または undefined は出さない

思考（B、`ThinkingLine.js`）:

- 実行中の action は `Thinking`
- 完了後の既定 action は `Thought`。本文の先頭が `**見出し**` または `# 見出し` だけのときはその見出し
- 500ms 未満は `briefly`。それ以外は秒
- 本文が空なら展開しない
- Cursor には `Planning next moves` という模擬思考がある。この拡張では表示しない

ツールグループ（B、`step-group-display.js`）の優先順:

1. ツールが無く思考だけ: Thinking / Thought
2. ブラウザ操作だけ: Running / Ran、`N browser actions`
3. 待機ジョブ: Monitoring background tasks / Monitored
4. 編集・削除だけ: キャンバス向け動詞、または失敗時 `attempted`
5. コマンドだけ: Running / Ran。1 件なら説明文、複数なら `N commands`
6. 画像だけ: Generating / Generated
7. それ以外: Exploring / Explored。詳細は `N files`、`N searches`、`N fetches`、`lints`、`N tools`、`ran N commands`、`+additions -deletions`

単体の動詞（B）: Read / Reading、Ran / Running、Edited / Editing、Searched、Grepped、Listed、Deleted。失敗ラベルは別フィールド。

ステップリストの gap は 6px（B）。行は font-size 12px、padding `1px 0 1px 0.5rem`、radius 4px、gap 8px。

計画（B）: `createPlanToolCall` の完了は `Wrote plan`。アクションに `View Plan` がある。Build の分岐にはクラウドがある。この拡張の Build はローカルの Agent 実行のままにする。

ファイル変更の文言（B）: 1 件ならファイル名または `1 file`、複数なら `N files`。増減は `+N -M`。

Composer の classic 入力（B）: `.ai-input-full-input-box` は column、gap 6px、padding `8px 10px 6px`、角丸の既定 8px、背景 `--vscode-input-background`。Agents の空プロンプト（A）は角丸 20px で、classic 入力とは別物。

## 未計測

2026-10-29 に、ワークベンチのチャット列で質問、計画、レビュー帯、受け入れ後のトークン内訳を測った。数値は [CURSOR_UI_CHAT_LIVE_2026.md](CURSOR_UI_CHAT_LIVE_2026.md)。次は、その回でも残っているものである。

- 編集用サイドバー（auxiliary bar）の実 DOM
- 思考の展開本文、ツール展開、インライン diff、Approval の computed style
- Light と High Contrast の計算色
- ストリーミング中の開閉
- 入力の自動伸長後の高さ
- モデルメニューの座標

ユーザーカード、折りたたみの Thought、計画ボタン、レビュー帯、会話中 Composer は実行画面で測れた。上の残りは、CSS / JS の宣言があるものだけ B とし、実行画面の px としては書かない。
