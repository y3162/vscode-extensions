# Architecture

拡張機能はエージェントの推論、サンドボックスの強制、ツール実行を再実装しません。役割は次の4層です。

```text
Webview
  チャット、入力、承認カード、キュー、変更一覧
Extension host
  セッション制御、コンテキスト組み立て、差分の表示と復元、Capabilities
SDK / Protocol
  @cursor/sdk、Cursor CLI ACP、@openai/codex-sdk、Codex App Server
Agent runtime
  推論、ツール、OSサンドボックス、Rules、Skills、MCP、セッション永続化
```

## 通信の選び方

| プロバイダー | 既定 | 追加 | 理由 |
| --- | --- | --- | --- |
| Cursor | `@cursor/sdk` 1.0.37 | `agent acp` | SDKはローカル実行、モデル、画像、使用量、resume を公式に提供する。対話承認、Ask、`cursor/ask_question`、`cursor/create_plan` は ACP の JSON-RPC でしか受け取れない |
| Codex | `@openai/codex-sdk` 0.162.1 | `codex app-server` | SDKは `codex exec` をターンごとに起動し、stdin を閉じる。承認、質問、steer、レビュー、スレッド一覧は App Server の双方向 JSON-RPC が必要 |

既定を SDK のままにしたのは、0.3.0 までの動作と統合テストを維持するためです。サイドバーの「バックエンド」で ACP または App Server に切り替えます。

SDK で `on-request` のような対話承認を選ぶと、プロセスが入力を待ったまま止まるため、その場合はエラーにして App Server への切り替えを案内します。

## サンドボックスと承認

サンドボックスの強制はランタイムです。

- Cursor SDK: `local.sandboxOptions.enabled`。有効時、範囲外の操作は対話なしで拒否されます。無効時は確認なしで実行されます。
- Cursor ACP: 起動引数 `--sandbox enabled|disabled`。ツールごとの判断は `session/request_permission` です。
- Codex: `read-only`、`workspace-write`、`danger-full-access`。ネットワークは `networkAccessEnabled` または App Server の config です。オフを選んでも「拡張機能がネットワークを遮断した」とは表示しません。未指定のときはランタイムの既定です。

自動承認はサンドボックスではありません。`ai-agents.autoApprove` は既定で false で、有効化には確認ダイアログが必要です。セッション中の「このセッションでは許可」はプロセス内のメモリだけで、新しい会話では消えます。

## セッション

`ChatController` は1つの実行だけを持ちます。Webview を閉じても実行は止めません。停止、新しい会話、プロバイダー変更、サンドボックス変更で破棄します。モード変更は、接続中のセッションが `setMode` を実装していれば会話を維持します。

復元は `Agent.resume`、`resumeThread`、ACP `session/load`、App Server `thread/resume` を使います。表示用の履歴がプロトコルから来ない場合は、その旨を状態メッセージにします。

## ファイル変更

エージェントが書く前にパスが分かれば、その時点の内容を baseline として保持します。既に書かれた後で diff だけが来る場合は、ワークスペース内のパスに限って `git apply --reverse` を試みます。Codex の `thread/revert` は会話履歴だけを戻すため、ファイル復元には使いません。

復元前に、字句上のパスと `realpath` の両方がワークスペース配下であることを確認します。

## コンテキスト

`@file` と `@folder` はワークスペース内のテキストだけをプロンプトへ足します。選択範囲、Problems、`git diff`、シェル統合で観測できた最近のコマンドも拡張機能が組み立てます。VS Code はターミナルの画面バッファを拡張機能へ渡さないため、スクロールバック全文は取得しません。

Rules、Skills、MCP の実行はランタイムです。Cursor SDK では `settingSources: ['project', 'user']` を渡して読み込ませます。拡張機能はファイル名とサーバー名だけを表示し、`mcp.json` の環境変数は出しません。

## Webview

スクリプトは nonce 付きで、CSP は `default-src 'none'` です。画像プレビューだけ `img-src data:` を許可します。エージェント出力は `textContent` か、エスケープしたテキストから作る DOM で描画し、HTMLとして解釈しません。Webview からのメッセージは種別とフィールドを確認してから使います。APIキーは Webview へ送りません。

## 今回やらなかったこと

- Cursor Cloud / Background の起動。課金とリモート実行を伴うため、確認用のUIを別に設計してからにします。
- 1つのサイドバーでの同時実行。キューとセッション一覧で足りる範囲に留めました。
- Inline Edit、補完、意味検索。エージェントのツール実行とは別のAPIが必要です。
