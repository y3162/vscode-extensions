# レイアウトが画面で感じられなかった原因（2026-10-28）

対象 HEAD は `1242c79`（`cursor調査リポジトリを踏まえて`）。作業開始時の `main` は `origin/main` と一致し、未コミット差分はなかった。

## 結論

主因は B。A は、開いたままのサイドバーや別インストールでは起こりうるが、この作業で開いた Extension Development Host はリポジトリの `dist/webview` を読んでいた。

### A. 実画面がソースを直接読まない

本番 Webview は [sidebar.ts](../src/sidebar.ts) が `dist/webview/main.css` と `dist/webview/main.js` をリンクする。CSS は [scripts/build.mjs](../scripts/build.mjs) が `src/webview/styles.css` をコピーする。`src/webview/main.ts` は CSS を import しない。

作業開始時、`src/webview/styles.css` と `dist/webview/main.css` の SHA-1 はどちらも `392bb315b87d458e01a2e44ae63d94002ccb8048` だった。ソースと配布物は一致していた。

ユニットテストは happy-dom で TypeScript を実行し、CSS は文字列一致だけを見る。はみ出し検出はフレーム外にはみ出したかを見る。どちらも「右寄せになったか」は見ない。`retainContextWhenHidden: true` で、CSS の URL に版クエリがない。開いたままのサイドバーは、ビルド後も古いシートを保持する。

隔離した VS Code 1.142.0（`user-data-dir` は `/private/tmp/ai-agents-layout-verify/user-data`。通常プロファイルではない）で、Webview の stylesheet は次だった。

`https://file+.vscode-resource.vscode-cdn.net/Users/sekiyuuta/Developer/y3162/vscode-extensions/extensions/ai-agents/dist/webview/main.css`

`.bubble` の指定は `width: fit-content`、`max-width: min(34em, 88%)`。`.user-row` は `align-items: flex-end`。これは今回のソースと一致する。

目印として `dist/webview/main.css` だけに `.top-bar { outline: 4px solid rgb(255, 0, 170) }` を足し、Extension Development Host を再読み込みした。computed style は `outline-width: 4px`、`outline-color: rgb(255, 0, 170)` になった。ファイルを元に戻して再読み込みすると、outline はテーマ由来の `3px` / `rgb(204, 204, 204)` に戻った。目印はソースにも成果物にも残していない。

内側の `fake.html` を `location.reload()` すると VS Code の Webview 接続が切れて空になる。反映確認はワークベンチの再読み込みで行った。

### B. 前回の差分は配置を変えていなかった

前回の CSS は `.user-row { align-items: stretch }`、`.bubble { width: 100% }` だった。短い発話もカラム全幅の帯になる。[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) の右寄せとも、静的プロトタイプ C の `max-width: 90%` とも違う。[UI_DELTA_2026.md](UI_DELTA_2026.md) が決めたのは面の色と枠の有無である。[IMPROVEMENT_REPORT_2026.md](IMPROVEMENT_REPORT_2026.md) の 528 枚は、要素がフレームの外に出ていないことの検出である。

Before の `docs/ui-layout-2026/before/chat-390-dark-ja.png` では、ユーザー発話が会話幅いっぱいの帯になっている。After では内容幅で右に寄る。
