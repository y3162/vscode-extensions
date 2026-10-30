# Cursor UI fidelity audit (2026-10-30)

## 範囲と証拠

Cursor 3.26.13、commit `3bfec373749d3d4a53a151283022d49743ab50b0`。ローカルの署名済みアプリを読み取り専用で確認した。`out/vs/workbench/workbench.desktop.main.js` / `.css` と `workbench.glass.main.js` / `.css` を文字列検索し、HTML入口 `out/vs/code/electron-sandbox/workbench/workbench.html` を確認した。HTMLはシェルで、チャットDOMは含まない。バンドル全文は保存していない。レンダラー位置、状態分岐、StyleXおよびCSS規則の既存抽出は [source analysis](CURSOR_UI_SOURCE_ANALYSIS_2026.md) と [機械可読データ](cursor-ui-analysis/source/index.html) を参照。該当クラスの存在を今回両バンドルで再確認した。Thinkingの生成クラスは主要CSSでは見つからず、供給元は未確定。

実測は [保存済みWorkbenchチャット](CURSOR_UI_CHAT_LIVE_2026.md)、400px、Dark、エディタ背景 `#181818`。DOM、computed style、矩形は [chat-live](cursor-ui-analysis/chat-live/index.html)。空のAgents WindowやGlassの値とは区別する。新規画面操作・撮影はしていない。以下のPASSは記載した項目に限り、全体のピクセル一致を意味しない。

## 対応と差分

| Cursor renderer → DOM / CSS → 実測 | AI Agents対応 | 判断 |
| --- | --- | --- |
| human renderer → `.composer-rendered-message` → `.composer-human-message:not(.standalone-glass)` → 368px、12px、白12%枠、13px/18.2px | `.user-row > .user-card` | 幅・枠・行高維持。通常CSSはinput背景を指定。実測の半透明背景の合成・カスケードは未確定 |
| `ThinkingLine` → `.ui-thinking-collapsible` / `.ui-collapsible-header` → 14px/22px、gap 4px | `.thinking` / `.activity-row` | 寸法維持。実測文字は `rgba(240,240,240,.74)`、テーマのdescriptionForegroundとのRGB差はテーマごとに未測定 |
| work group renderer → `.agent-transcript-row-work-group` / header → 22px | `.activity-group` / `.tool-line` | ヘッダー維持。展開ツール、Terminal、diffは実測不足 |
| assistant → `.ui-markdown__paragraph` → 背景・枠なし、14px/22px | `.answer` | 文字寸法を修正。背景・枠なし維持 |
| review renderer → `.composer-toolbar-section-header` → Composer直上、20pxボタン | `.review-bar` / `.review-action` | 既存の状態と寸法を維持。実測Review背景 `rgb(98,98,98)`、テーマsecondary色とのRGB差は未測定 |
| input renderer → `.full-input-box` → `.composer-bar-input-buttons` / `.composer-unified-dropdown` → 75px、padding 8/10/6/10、gap 6、28px行、20px mode | `.composer-card` / `.composer-row` / `.mode` | gap、入力文字、mode形状・背景を修正。外枠と操作行維持 |
| plan renderer → activity / `.ui-tool-call-card__body`、本文は別 `.plan-editor` → 24px/6pxボタン | `.plan-card` / `.plan-actions` | ボタン寸法維持。Webview内の本文とテーマボタンを維持 |
| Approval / Subagent / dropdown | `.banner`, `.subagent-*`, `.menu` | 保存済み実測がなく、状態や機能を優先して維持。静的な存在だけで表示時の見た目を断定しない |

CSS静的根拠: desktop `.ai-input-full-input-box` は input背景、flex column、gap `.375rem`、padding `.5rem .625rem .375rem`。humanは input背景、secondary stroke、surface radius、幅100%。実測Composerは白3.5% alpha、Userは灰13.5% alphaだが、変数と合成の全カスケードは未解明。VS Codeのテーマ変数の値はユーザーのテーマで変化するため、色のRGB差は固定できない。今回のModeは前景14%を混合し、Dark実測に寄せつつテーマに追従する。境界はcontrastBorderを優先する既存規則を維持した。

## 比較表

変更前・変更後はCSS静的解析、Cursorは明記した保存実測。ブラウザの新規computed値ではない。

| コンポーネント | 変更前 | 変更後 | Cursor基準 | 判定 |
| --- | --- | --- | --- | --- |
| Composer | gap 0、入力 inherited / 1.45、mode 20px四角 | gap 6px、入力14px/22px、mode 20px pill・前景14% | 実測 gap 6、14/22、20px pill・白14%、枠20% | PASS（列挙値、色はテーマ依存） |
| User Message | 全幅、12px、前景12%枠、input背景 | 同左 | 実測 全幅、12px、白12%、半透明灰 | DIFF（背景合成未確定） |
| Assistant | 枠なし、body継承 / 1.57 | 枠なし、14px/22px | 実測 枠なし、14px/22px | PASS（本文） |
| Activity | 14px/22px、gap 4 | 同左 | 実測 14px/22px、gap 4 | PASS（寸法、色未比較） |
| Tool | 22px見出し、展開内容独自 | 同左 | 見出し実測22px、展開未測定 | DIFF（詳細未確認） |
| Review | 20px、4px角、Composer直上 | 同左 | 実測20px、4px角、直上、背景98/98/98 | DIFF（背景テーマ依存） |
| Plan | 24px、6px角、本文Webview内 | 同左 | 実測24px、6px角、本文別エディタ | DIFF（構造は意図的） |

サイドバー背景は `sideBar.background`、ComposerとUserは `input.background`、コードは `textCodeBlock.background`、メニューは `editorWidget.background`、補助文字は `descriptionForeground` を使用する。Cursor Darkの実測とのRGB差は対応テーマの計算値がないため未確定。Light / High Contrast、hover、popup、展開Thinking / terminal、approval / subagentのCursor実画面も未確認。幅640pxの中央カラムはAI Agents独自仕様として維持する。バックエンド、プロトコル、状態遷移は変更していない。

## 検証

スクリーンショットなしのブラウザfixtureは396シーン、機能22項目に成功。Dark 390px fixtureのcomputed styleはComposer行28px、padding `8px 10px 6px`、角丸12px、枠 `srgb(0.8 0.8 0.8 / 0.2)`、Mode 20px / 12px、Activity 14px / 22px / gap 4px、User 13px / 18.2px。Cursorの枠は白20%なので、fixtureの前景 `#ccc` との差は残る（合成背景に依存し、最終RGB差は未計算）。型・ユニット・coverage・hygiene・build・統合テストは成功。ユニットの初回並列実行ではGitプロセス起動待ちが1件失敗し、単独再実行では852件成功。

実Host受入はスクリーンショットなしで実行。初回はT01–T03、T07–T12、T14、T16–T18がPASS。T04–T06はHost準備中のディスク不足で失敗し、容量確保後の個別再実行ではT04・T06がPASS、T05はHost側のT05待機タイムアウト。T15は個別再実行でPASS。T13は初回・再実行ともPlan Buildボタンの待機失敗。T19は初回Light Modern 300pxの実幅が765pxで失敗し、再実行では12条件の幅・テーマ測定は成功したが、コンポーネント幅チェックがタイムアウト。T20は初回Plan Buildボタン待ち、再実行は完了ターン待ちで失敗。これらの原因がCSS変更にあるかは未確定で、T01–T20全件PASSとは判定しない。Hostには通常Quitを使用した。
