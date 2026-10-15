# Verification

実施日: 2026-10-16。作業ディレクトリは `vscode-extensions`。対象は AI Agents 0.5.0。

## 実行した結果

| Check | Result |
| --- | --- |
| `npm run check` | 成功。拡張機能ホストと Webview の `tsc --noEmit` |
| `npm test --workspace ai-agents` | 48 passed, 0 failed |
| `npm run build` | esbuild 成功（`dist/extension.js` と `dist/webview/main.js`） |
| `npm run test:integration` | 成功。0.4.0 の項目に加え、プロバイダー切替、履歴の再開、サンドボックス変更による新しい会話、Diff Editor、復元、App Server の承認とトークン、Webview の履歴表示 |

0.4.0 で確認していた単体テストは、この 48 件の中に残っている。追加したのは、チャンクの結合、ツール情報、状態の差分、承認トークン、ターンの分割、Markdown のエスケープと差分描画、Enter / Shift+Enter / IME、キュー、履歴の呼び出し、候補のキー操作、質問カードの複数回答。

統合テストで確認したログ:

- sidebar webview loaded its script and completed the ready handshake
- sidebar → Codex SDK → subprocess → responses, tool output, and follow-up
- backend errors are shown and a new prompt can run afterward
- Stop terminates a running SDK subprocess; a queued prompt survives Stop and can be sent; New Chat clears the conversation
- models are discovered, chosen in the native picker, and passed to the SDK
- cancelling the model picker preserves the active conversation and selection
- reselecting the base model preserves effort/context settings and conversation
- detail changes apply atomically and Codex SDK forwards the selected effort
- cancelling detail edits preserves settings and conversation
- provider switch, history, sandbox reset, diff revert, approval token, and webview probe

## 画面

同じ Webview バンドルを、テーマ変数だけを足したプレビューで確認した。幅 390px と 300px、ダークとライト。

確認した状態: 空のチャットと最近の履歴、完了したターン、展開したツール、実行中、承認カード、フルアクセスの警告、履歴一覧、英語 UI。

Extension Development Host では、統合テストが Webview の起動、履歴パネル、ターン数を読んだ。セカンダリサイドバーを手で開いた見た目の撮影は、この環境では行っていない。

## 未検証

- `AI_AGENTS_LIVE_TEST`、`AI_AGENTS_LIVE_MODELS_TEST`、`AI_AGENTS_LIVE_CURSOR_MODELS_TEST` は実行していない。実アカウントへの推論、実モデル一覧、実ファイル変更は未確認。
- インストール済みの `agent acp` と `codex app-server` への実接続は未確認。プロトコルテストは同梱のモックプロセス。
- 日本語 IME の実機操作、画像の貼り付け、ハイコントラストテーマの目視は未確認。IME は happy-dom の `compositionend` と `isComposing` で、確定直後の Enter が送信されないことまで確認した。
