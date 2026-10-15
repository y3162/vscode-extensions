# Implementation Progress

## Phase 0

Feature Matrix、Gap Analysis、Architecture を `docs/` に作成した。判定は 0.3.0 のソースとテスト、`@cursor/sdk@1.0.37`、`@openai/codex-sdk@0.162.1`、参考実装 v0.3.7 のコードに基づく。

## Phase 1

完了。共通チャット、バックエンド切替、接続状態、既存のモデル選択、モード、ストリーミング、Markdown、ツール折りたたみ、停止、新しい会話、セッション一覧と再開、エラー表示、入力キュー、ショートカット、日英UI、テーマ変数。

スキップ: Quick Pick のモデル選択と詳細設定。テスト済みの動作を作り直していない。

## Phase 2

完了（ターミナル全文は Partial）。`@file`、`@folder`、アクティブファイル、選択範囲、検索、画像、スラッシュコマンド、Problems、Git差分、変更一覧、Diff Editor、復元、エディタのコンテキストメニュー、ワークスペースフォルダ。

未対応: ターミナルの画面バッファ。VS Code の安定APIでは取得できないため、シェル統合の最近のコマンドだけを添付する。リモート開発は、拡張機能ホスト側で CLI と SDK が動くことが条件で、専用のリモート実装は足していない。

## Phase 3

完了（一部 Partial）。サンドボックスと承認ポリシー、ツール承認、計画承認、質問、セッション内許可、明示的な自動承認、MCP/Skills/Rules の参照、TODO、トークン使用量、履歴、ファイルbaseline。

見送り:

- 同時に複数のエージェントを走らせるコントローラーへの作り替え。キューとセッション一覧に留めた。
- Git worktree の作成。既存のフォルダ選択で作業ディレクトリを渡す。
- ターン単位のGitブランチ作成。未コミットの変更を動かさないため。

## Phase 4

完了（Cloud は見送り）。ACP で `session/request_permission`、`cursor/ask_question`、`cursor/create_plan`、ツール更新、モード、セッション一覧。SDK では `settingSources`、agent/plan、画像、usage、resume、`messages.list`。

見送り: Cursor Cloud / Background。起動すると課金とリモートVMを使うため、確認用の専用UIなしでは接続しない。`cursor/task` と `cursor/generate_image` はイベントを表示できる範囲に留め、画像生成そのものはランタイムに委譲する。

## Phase 5

完了（SDK経路では対話機能を無効化）。App Server で承認、計画、質問、steer、fork、compact、review、rate limit、skills、MCP、instruction sources。SDK経路は従来の exec を維持し、対話承認が必要なポリシーはエラーにして App Server を案内する。

## Phase 6

Inline Edit、補完、意味検索、インラインレビュー、テスト失敗からの自動修正、独自ワークフローは未着手。エージェント実行とは別の推論APIが必要で、共通機能の後に検討する。
