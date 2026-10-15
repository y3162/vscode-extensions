# Verification

実施日: 2026-10-16。作業ディレクトリは `vscode-extensions`。

## 実行した結果

| Check | Result |
| --- | --- |
| `npm run check` | 成功。`tsc --noEmit` と `node --check media/chat.js` |
| `npm test --workspace ai-agents` | 36 passed, 0 failed |
| `npm run build` | esbuild 成功（`dist/extension.js`） |
| `npm run test:integration` | 成功。Webview の ready、Codex SDK の往復と resume、エラー後の再送、Stop、キューの保持と Send now、New Chat、モデル選択、選択キャンセル、詳細設定の適用とキャンセル |

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

## 単体テストで見た範囲

- 既存のセッション継続、停止、プロバイダー切替、モデル一覧、詳細設定
- 入力キューが Stop 後も残り、Send now で送られること
- 承認が選ばれるまで保留され、セッション内許可が2回目を自動で許可すること
- 使用量だけの更新が空メッセージにならないこと
- ワークスペース外とシンボリックリンクの復元拒否、変更前テキストの書き戻し
- `@file` の展開とプレーンプロンプトが変わらないこと
- 画像のMIMEと枚数制限
- モックプロセスに対する Cursor ACP と Codex App Server のストリーム、承認、一覧、fork、rate limit

## 未検証

- `AI_AGENTS_LIVE_TEST`、`AI_AGENTS_LIVE_MODELS_TEST`、`AI_AGENTS_LIVE_CURSOR_MODELS_TEST` は実行していない。実アカウントへの推論、実モデル一覧、実ファイル変更は未確認。
- インストール済みの `agent acp` と `codex app-server` への実接続は未確認。プロトコルテストは同梱のモックプロセス。
- Extension Development Host での見た目、狭い幅、IME、画像貼り付けの手操作は未確認。統合テストは Webview の起動と ready まで。
- セカンダリサイドバーを開いた状態の手操作は未確認。ビュー登録と、既存の `ai-agents.chat` の起動は確認した。
