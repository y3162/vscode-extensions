# Cursor 実チャットの解析（2026-10-29）

Cursor 3.26.13（commit `3bfec373749d3d4a53a151283022d49743ab50b0`、stable、2026-10-20）。Electron 42.10.0、Chrome 148.0.7778.280。前回の空 Agents Window と同じビルドである。

本番 Webview と CLI は変更していない。数値の正本は [cursor-ui-analysis/chat-live/](cursor-ui-analysis/chat-live/index.html)。

## 調査対象ウィンドウ

隔離プロセス PID 34502。デバッグポートは `127.0.0.1:9334`。ユーザーデータは `/tmp/cursor-ui-probe-chat-20261029/user`。通常プロファイルは使っていない。

会話が出ていたのは、タイトルがワークスペース名の通常ワークベンチである。右の editor group がチャット（`has-composer-editor`）で、幅は 400px。左の editor group は 880px で、計画ドキュメントかプレビューだった。

同じプロセスの「Cursor Agents」ウィンドウは、空のホームのままだった。今回の数値はそこから取っていない。`data-cursor-glass-mode` は、このワークベンチの page では null だった。テーマは Dark で、エディタ背景は `#181818`。ビューポートは 1280×800 のまま変えていない。

## 観測した状態

| 状態 | 画面 | 記録 |
| --- | --- | --- |
| Plan の質問 | スクロールの下に Questions。1 of 2。Continue は未選択で disabled | `state-plan-questions.json` |
| 計画の表示 | 左が `.plan-editor`。右に Thought 6s と Created Plan、View Plan、Build | `state-plan-view.json` |
| Build 後 | モードは Agent。Composer 直上に 2 Files、Undo All、Keep All、Review | `state-build-review-bar.json` |
| 受け入れ後 | Undo All と Keep All が消える。Context Usage の内訳が開いている | `state-accepted-tokens.json` |

スクリーンショットは会話本文を含むのでリポジトリの外、`/tmp/cursor-ui-probe-chat-20261029/captures/` に置いた。

## 実 DOM

チャット列の上から下は、仮想スクロール、必要なら Context Usage、レビュー帯、Composer である。質問中は、スクロールと Composer の間に `.composer-questionnaire-toolbar` が入る。

ユーザー発言は `.composer-human-message`。親に `.composer-rendered-message` がある。前回、このクラスは desktop CSS の出現回数 0 だったが、この実行 DOM にはある。

思考と探索の見出しは `.ui-collapsible-header`。見えた動詞は Thought と Explored。行は高さ 22px、幅 346px。23 個のうち 22 個が閉じていた。開いた本文と、Ran / Edited の展開は、仮想リストの外にあり計測していない。

計画のチャット側は枠のない `.agent-transcript-row-activity` と `.ui-tool-call-card__body` である。計画本文そのものは別エディタの `.plan-editor`（TipTap）で、Monaco ではなかった。

レビュー帯は `.composer-toolbar-section-header`。ファイル数は `.composer-toolbar-section-header-label`。

Composer は `.full-input-box`。操作行は `.composer-bar-input-buttons`。モードは `.composer-unified-dropdown`。モデルは `.vscode-model-picker__trigger`。

トークン内訳は `.composer-context-usage-tray-slot`。カードの角丸は 12px、背景は `rgb(24, 24, 24)`。

## CSS 実測

チャット内容の幅は 368px。列の左右パディングは 16px。

ユーザーカードは列幅いっぱい、`align-self: flex-end`、角丸 12px、枠 1px（白の 12%）、背景は半透明の灰、文字 13px / 行高 18.2px。外側の padding は 0 だった。短い右吹き出しではない。

Thought / Explored の見出しは 14px / 行高 22px、内部 gap 4px、背景なし。

アシスタント段落は 14px / 行高 22px、枠も背景もなし。

View Plan は 76×24、角丸 6px、透明。Build の分割ボタンは 95×24、角丸 6px、主ボタンの背景は Dark で `rgb(241, 180, 103)`。

レビューのボタンは高さ 20px、角丸 4px、文字 12px。Review だけ背景 `rgb(98, 98, 98)`。Composer との間隔は 0。

Composer 全体は 368×75、角丸 12px、padding `8px 10px 6px 10px`、枠は白の 20%、背景は白の約 3.5%。操作行は高さ 28px の grid で、左右に分かれる。40px ではない。モードの pill は高さ 20px、文字 12px。

計画ドキュメントのラッパーは最大幅 800px、padding `32px 24px 64px`。本文 13px / 20.8px。H1 は 22.75px、H2 は 19.5px、どちらも太さ 600。

Context Usage のカテゴリ行は高さ 24px、gap 8px、ラベル 12px / 16px。カテゴリは System prompt、Tool definitions、Rules、Skills、MCP & dynamic tools、Subagent definitions、Conversation。件数はこの会話の表示であり、仕様の定数にしない。

## スクリーンショットとの対応

| ファイル | 対応する領域 |
| --- | --- |
| `plan-questions-1of2.png` | 質問ツールバー y=418、Composer y=693 |
| `plan-view.png` | 左の plan-editor と、右の Thought / View Plan / Build |
| `build-review-bar.png` | レビュー帯 y=667 と Composer y=693 |
| `accepted-tokens.png` | Context Usage y=372 と、Undo / Keep が無いレビュー帯 |

## 未観測

幅 300 / 390 / 600 / 1000、Light、High Contrast、ストリーミング、思考の展開本文、ツール展開、ターミナル出力、インライン diff、承認、サブエージェント、モデルメニュー、モードメニュー、Agents Window の会話、auxiliary bar のサイドバーチャット。
