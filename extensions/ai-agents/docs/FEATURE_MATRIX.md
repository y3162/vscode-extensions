# Feature Matrix

調査日: 2026-10-16。対象バージョンは `@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`、`@openai/codex@0.162.1`、参考実装 `yutat23/cursor-agent-sidebar` v0.3.7 です。

状態の意味: Implemented は完成済み、Partial は一部、Missing は未実装、SDK-native はランタイム側、VSCode-native は VS Code API、Unsupported は公式 API で利用不可、Defer は今回の範囲外です。

既定の通信は従来どおり SDK です。対話型の承認や Codex のレビューは、サイドバーのバックエンドで ACP または App Server を選んだときだけ有効になります。これは既存の SDK 経路とテストを壊さないためです。

| Feature | Category | Phase | Reference | Cursor | Codex | Runtime | SDK / Protocol | VS Code | Extension | Status | Decision | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| チャットUI | Common | 1 | Secondary sidebar、Markdown、ツール折りたたみ | 共通UI | 共通UI | なし | ストリーミングイベント | Webview | ヘッダー、下部 Composer、ターン描画 | Implemented | Implement | `src/webview`, `src/sidebar.ts` |
| プロバイダー切替 | Common | 1 | Cursor のみ | SDK / ACP | SDK / App Server | なし | セッション作成 | 設定 | 切替とセッション破棄 | Implemented | Implement | `ChatController.select` |
| モデル選択 | Common | 1 | Composer の階層メニュー | `Cursor.models.list` | App Server `model/list` | カタログ | 一覧API | Quick Pick はコマンドから残す | Webview で検索して選択。ACP はモデルを送らないため Composer には出さない | Implemented | Implement | `src/webview/composer.ts`, `src/sidebar.ts` |
| モデル詳細 | Common | 1 | Effort / Context / Fast を階層で表示 | parameters / variants。次の `send({ model })` | reasoning effort のみ。スレッド作成時 | 推論設定 | 作成時または次の送信 | Quick Pick はコマンドから残す | カタログが返す値だけ。Codex に Context と Fast は出さない | Implemented | Implement | `src/model-settings.ts`, `src/providers/models.ts` |
| 動作モード | Common | 1 | agent / plan / ask | SDK は agent/plan、ACP は ask も可 | App Server は default/plan | モードの実行 | `mode` / `collaborationMode` / `session/set_mode` | ドロップダウン | Capabilities で選択肢を制限 | Implemented | Implement | `src/capabilities.ts` |
| ストリーミング | Common | 1 | chunk 描画 | assistant / thinking / tool | item delta と item snapshot | 生成 | stream / JSON-RPC | Webview | 同一IDの置換 | Implemented | Implement | `ChatController.send`, `providers/events.ts` |
| Markdown | Common | 1 | 独自パーサとハイライト | テキスト | テキスト | なし | なし | なし | DOM生成。HTMLは解釈しない | Implemented | Implement | `src/webview/markdown.ts` |
| 入力キュー | Common | 1 | Queue / Send now / Stop保持 | 拡張機能側 | App Server は steer も可 | なし | `turn/steer` は App Server のみ | なし | Stop ではキューを残す | Implemented | Implement | `ChatController.enqueue`, `test/queue-and-review.test.ts` |
| セッション一覧・再開 | Common | 1 | ACP list/load と SQLite 解析 | SDK `Agent.list/resume`、ACP `session/list/load` | SDK `resumeThread`、App Server `thread/list/resume` | 永続化 | 各プロトコル | なし | 公式APIと拡張機能が作った索引。内部DBは読まない | Partial | Implement | `openSession`, `refreshSessions` |
| 日本語・英語 | Common | 1 | 独自 ja/en | 共通 | 共通 | なし | なし | `vscode.env.language`, `package.nls` | Webview と新規コマンド | Implemented | Implement | `package.nls.ja.json`, `src/webview/strings.ts` |
| テーマ追従 | Common | 1 | `--vscode-*` | 共通 | 共通 | なし | なし | CSS変数 | 既存方針を維持 | Implemented | Skip | `src/webview/styles.css` |
| `@file` / `@folder` | IDE | 2 | ワークスペース検索 | プロンプトへ展開 | 同左 | モデルが読む | なし | `findFiles` | ワークスペース外は拒否 | Implemented | Implement | `src/context-text.ts`, `src/vscode-context.ts` |
| 選択範囲・問題・Git差分 | IDE | 2 | なし、または限定的 | プロンプトへ添付 | 同左 | なし | なし | Diagnostics / git | 拡張機能がテキスト化 | Implemented | Implement | `vscode-context.ts` |
| ターミナル出力 | IDE | 2 | なし | 最近のコマンドのみ | 同左 | なし | なし | Shell integration | 画面バッファは API 非公開 | Partial | Integrate | `watchTerminals` |
| 画像 | IDE | 2 | 貼り付け | SDK は base64、ACP は image block | SDK / App Server は一時ファイル | 画像入力 | `images` / `local_image` / `localImage` | なし | 4枚・5MB・許可MIME | Implemented | Implement | `src/images.ts` |
| 差分表示 | IDE | 2 | `vscode.diff` と変更前テキスト | ツール開始時のbaseline、または diff | 変更イベントの path / diff | ファイル書き込み | tool / file_change | Diff Editor | 一時baselineを開く | Partial | Implement | `writeBaselineFile`, `reviewFile` |
| ファイル復元 | IDE | 2 | 変更前テキストの書き戻し | baseline があるとき | baseline または `git apply --reverse` | なし | Codex `thread/revert` は会話のみ | ファイルAPI | realpath でワークスペース外を拒否 | Partial | Implement | `src/change-review.ts` |
| サンドボックス設定 | Common | 3 | CLIフラグ | `sandboxOptions.enabled` または `--sandbox` | `read-only` / `workspace-write` / `danger-full-access` | OSサンドボックス | 作成時オプション | 設定UI | 変更すると新しい会話 | Implemented | Implement | `capabilitiesFor` |
| 承認ポリシー | Common | 3 | 3段階承認 | ACP は要求ごと。SDKは対話不可 | App Server は untrusted/on-request/never。SDKは never のみ | 判定 | permission RPC | カードUI | 未対応ポリシーは App Server へ案内 | Implemented | Implement | `requestPermission` |
| 自動承認 | Common | 3 | 設定と確認 | ACP / SDK 共通の拡張機能設定 | 同左 | なし | なし | 確認ダイアログ | 既定オフ。サンドボックスとは別 | Implemented | Implement | `ai-agents.autoApprove` |
| MCP / Skills / Rules | Common | 3 | スラッシュ展開 | SDK は `settingSources: project,user` | App Server は `skills/list` と `instructionSources` | 読み込みと注入 | 設定ソース / RPC | ファイル一覧 | 秘密情報は表示しない | Partial | Integrate | `instructionSummary` |
| TODO / 計画 | Common | 3 | plan card。update_todos は未接続 | `updateTodos` / ACP `cursor/create_plan` | `todo_list` / plan notifications | 計画生成 | イベント | カード | 承認は ACP / App Server | Partial | Implement | `cursor-acp.ts`, `codex-app-server.ts` |
| トークン使用量 | Common | 3 | 非公式ダッシュボードAPI | SDK `usage` イベント | SDK `turn.completed`、App Server token usage | 計測 | 公式イベント | 表示 | Keychain や私設APIは使わない | Partial | Implement | `providers/details.ts` |
| レート制限 | Codex | 5 | なし | SDKに課金APIはあるがクラウド中心 | App Server `account/rateLimits/read` | アカウント | RPC | 表示 | App Server 選択時 | Partial | Implement | `rateLimits()` |
| チェックポイント | Common | 3 | ファイル単位の復元 | baseline | baseline。`thread/revert` はファイルを戻さない | なし | 会話の巻き戻しのみ | ファイル復元 | ターン全体のGit分岐は作らない | Partial | Implement | `change-review.ts` |
| Git worktree | Common | 3 | なし | `cwd` として利用 | 同左 | なし | `cwd` | フォルダ選択 | ワークスペースフォルダを選ぶ。worktree作成はしない | VSCode-native | Defer | ワークスペースAPIで足りる |
| 並列セッション | Common | 3 | 単一ビュー | 1実行 + キュー | 同左 | 複数エージェント | セッションAPI | なし | コントローラーの全面改修が必要 | Missing | Defer | `ChatController` は単一実行 |
| コードレビュー | Codex | 5 | なし | 差分を添付して依頼 | App Server `review/start` | レビュー | RPC | なし | SDKでは差分添付にフォールバック | Partial | Implement | `ChatController.review` |
| ACP独自イベント | Cursor | 4 | permission / plan / question。task と generate_image は未接続 | ACPが配信 | なし | ツール | JSON-RPC | カード / 状態 | task は表示。画像生成はパス表示 | Partial | Implement | `src/providers/cursor-acp.ts` |
| Cursor SDK設定 | Cursor | 4 | なし | rules/skills/hooks/mcp を `settingSources` で有効化 | なし | 読み込み | SDK | なし | クラウド起動ボタンは置かない | Implemented | Implement | `providers/index.ts` |
| Cloud / Background | Cursor | 4 | なし | SDKは対応 | 別製品 | リモートVM | SDK cloud | なし | 課金が発生するためUIは未接続 | SDK-native | Defer | ユーザー確認が必要な課金操作 |
| Codex sandbox / network / search | Codex | 5 | なし | なし | SDKフラグと App Server config | 強制 | `sandboxMode`, `networkAccessEnabled`, `web_search` | 設定UI | オフはランタイム既定のまま | Implemented | Implement | `SessionOptions` |
| コンテキスト圧縮 / fork | Codex | 5 | なし | なし | App Server `thread/compact/start`, `thread/fork` | 圧縮 | RPC | コマンド `/compact` | SDKでは不可と表示 | Partial | Implement | `codex-app-server.ts` |
| Inline Edit / 補完 | IDE | 6 | なし | 別API | 別API | 補完モデル | なし | Inline API | エージェント統合とは別 | Missing | Defer | 追加の推論基盤が必要 |

検証欄は `docs/VERIFICATION.md` にまとめます。
